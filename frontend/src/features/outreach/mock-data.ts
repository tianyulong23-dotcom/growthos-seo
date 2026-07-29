import type {
  BacklinkAssessmentComponent,
  BacklinkAssessmentRunStatus,
  BacklinkAssessmentView,
  BacklinkEvidenceValue,
  BacklinkPlacementCandidate,
  BacklinkPublicAssessment,
  RecommendationScoreComponentId,
} from "@/features/outreach/api/client"

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

export type OpportunityEmailStatus =
  "not_started" | "ready" | "draft" | "sent_waiting_reply" | "replied"

export type OpportunityManagementStatus = "ACTIVE" | "PAUSED" | "ARCHIVED"
export type OpportunityOutcomeStatus = "OPEN" | "WON" | "LOST"
export type OpportunityFulfillmentStatus =
  "NOT_EXPECTED" | "PENDING" | "PARTIAL" | "FULFILLED"

export type DraftFoundationStatus =
  "not_created" | "generating" | "draft" | "approved" | "rejected" | "sent"

export type DraftFoundation = {
  status: DraftFoundationStatus
  currentVersion: number | null
  evidenceSnapshotId: string | null
  promptVersion: string
  outputSchemaVersion: string
  providerMode: "disabled" | "fake"
  providerRef: string | null
  modelId: string | null
  realAdapterEnabled: false
  requiresHumanApproval: true
  canAutoSend: false
}

export type Recommendation = {
  id: string
  domain: string
  score: number
  relevance: string
  contactability: string
  assessment: BacklinkPublicAssessment
}

export type Opportunity = {
  id: string
  domain: string
  joinSequence: number
  businessStage: OpportunityBusinessStage
  managementStatus: OpportunityManagementStatus
  outcomeStatus: OpportunityOutcomeStatus
  fulfillmentStatus: OpportunityFulfillmentStatus
  version: number
  emailStatus: OpportunityEmailStatus
  contact: string
  assessment: BacklinkPublicAssessment
  assessmentRun: BacklinkAssessmentView
  draftFoundation: DraftFoundation
  placementCandidate: BacklinkPlacementCandidate | null
  nextStep: string
  updated: string
}

const componentIds: readonly RecommendationScoreComponentId[] = [
  "graph_authority_diversity",
  "topic_content_editorial_quality",
  "outbound_commercialization",
  "network_risk",
  "technical_health",
]
const componentWeights: Record<RecommendationScoreComponentId, number> = {
  graph_authority_diversity: 35,
  topic_content_editorial_quality: 30,
  outbound_commercialization: 15,
  network_risk: 15,
  technical_health: 5,
}
const dataForSeoRelease = "dataforseo-2026-07-25"
const crawlerRelease = "crawler-release-2026-07-25"

function observed<T>(
  value: T,
  sourceType: string,
  sourceReleaseId: string,
  evidenceRef: string,
  observedAt = "2026-07-25T01:00:00.000Z"
): BacklinkEvidenceValue<T> {
  return {
    availability: "observed",
    value,
    sourceType,
    sourceReleaseId,
    confidence: 0.94,
    observedAt,
    stale: false,
    evidenceRefs: [evidenceRef],
  }
}

function unavailable<T>(
  sourceType: string,
  sourceReleaseId: string,
  evidenceRef: string,
  reason: "not_observed" | "not_supported" = "not_observed"
): BacklinkEvidenceValue<T> {
  return {
    availability: "unavailable",
    reason,
    sourceType,
    sourceReleaseId,
    confidence: 0,
    observedAt: "2026-07-25T01:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  }
}

function currentAssessment(
  domain: string,
  score: number
): BacklinkPublicAssessment {
  const normalizedValue = score / 100
  const components: BacklinkAssessmentComponent[] = componentIds.map((id) => {
    const technical = id === "technical_health"
    const sourceReleaseId = technical ? crawlerRelease : dataForSeoRelease
    return {
      id,
      normalizedValue,
      weight: componentWeights[id],
      points: Number((normalizedValue * componentWeights[id]).toFixed(1)),
      availability: "observed",
      sourceType: technical
        ? "shared_crawler_site_audit"
        : "dataforseo",
      sourceReleaseId,
      confidence: technical ? 0.98 : 0.92,
      observedAt: technical
        ? "2026-07-25T01:00:00.000Z"
        : "2026-07-22T00:00:00.000Z",
      stale: false,
      evidenceRefs: [`assessment:${domain}:${id}`],
      unavailableReason: null,
      derivationRuleVersion: null,
    }
  })

  return {
    outcome: score >= 85 ? "low_risk" : "review_recommended",
    score,
    availability: "available",
    freshness: "fresh",
    scoreModelVersion: "recommendation-open-evidence-score.v1",
    ruleVersion: "recommendation-gates.v1",
    generatedAt: "2026-07-25T01:05:00.000Z",
    readOnly: false,
    sourceReleaseIds: [dataForSeoRelease, crawlerRelease],
    unavailableFields: [],
    staleFields: [],
    components,
  }
}

function legacyAssessment(
  domain: string,
  score: number
): BacklinkPublicAssessment {
  const sourceReleaseId = `legacy-score:${domain}`
  return {
    outcome: "insufficient_data",
    score,
    availability: "unavailable",
    freshness: "stale",
    scoreModelVersion: "legacy-score.v1",
    ruleVersion: "legacy-rules.v1",
    generatedAt: "2026-07-18T01:05:00.000Z",
    readOnly: true,
    sourceReleaseIds: [sourceReleaseId],
    unavailableFields: [...componentIds],
    staleFields: [...componentIds],
    components: componentIds.map((id) => ({
      id,
      normalizedValue: null,
      weight: componentWeights[id],
      points: null,
      availability: "unavailable",
      sourceType: "legacy_snapshot",
      sourceReleaseId,
      confidence: 0,
      observedAt: "2026-07-18T01:05:00.000Z",
      stale: true,
      evidenceRefs: [`legacy-assessment:${domain}`],
      unavailableReason: "not_supported",
      derivationRuleVersion: null,
    })),
  }
}

export function createAssessmentView(
  opportunityId: string,
  assessment: BacklinkPublicAssessment,
  options: {
    status?: BacklinkAssessmentRunStatus
    isCurrent?: boolean
    errorCode?: string | null
  } = {}
): BacklinkAssessmentView {
  const status = options.status ?? "SUCCEEDED"
  const isCurrent = options.isCurrent ?? status === "SUCCEEDED"

  return {
    run: {
      id: crypto.randomUUID(),
      opportunityId,
      status,
      attemptCount: status === "FAILED" ? 2 : 1,
      sourceReleaseIds: assessment.sourceReleaseIds,
      startedAt: "2026-07-27T01:03:00.000Z",
      finishedAt:
        status === "QUEUED" || status === "RUNNING"
          ? null
          : "2026-07-27T01:05:00.000Z",
      errorCode:
        options.errorCode ??
        (status === "FAILED" ? "EVIDENCE_SOURCE_UNAVAILABLE" : null),
    },
    result: {
      snapshotId: crypto.randomUUID(),
      snapshotVersion: 1,
      isCurrent,
      availability: assessment.availability,
      stale: !isCurrent || assessment.freshness === "stale",
      sourceReleaseIds: assessment.sourceReleaseIds,
      generatedAt: assessment.generatedAt,
      payload: {
        outcome: assessment.outcome,
        score: assessment.score,
        scoreModelVersion: assessment.scoreModelVersion,
        ruleVersion: assessment.ruleVersion,
      },
    },
  }
}

export function createDisabledDraftFoundation(): DraftFoundation {
  return {
    status: "not_created",
    currentVersion: null,
    evidenceSnapshotId: null,
    promptVersion: "outreach-draft-prompt.v1",
    outputSchemaVersion: "outreach-draft-output.v1",
    providerMode: "disabled",
    providerRef: null,
    modelId: null,
    realAdapterEnabled: false,
    requiresHumanApproval: true,
    canAutoSend: false,
  }
}

export function createLocalDemoDraftFoundation(
  status: "draft" | "approved" | "rejected" | "sent" = "draft",
  version = 1
): DraftFoundation {
  return {
    status,
    currentVersion: version,
    evidenceSnapshotId: crypto.randomUUID(),
    promptVersion: "outreach-draft-prompt.v1",
    outputSchemaVersion: "outreach-draft-output.v1",
    providerMode: "fake",
    providerRef: "fake-ai-draft",
    modelId: "fixture-success",
    realAdapterEnabled: false,
    requiresHumanApproval: true,
    canAutoSend: false,
  }
}

export function createDomainPlacementCandidate(
  candidateId: string,
  opportunityId: string,
  domain: string
): BacklinkPlacementCandidate {
  return {
    candidateId,
    opportunityId,
    sourceType: "dataforseo",
    sourcePageUrl: unavailable(
      "dataforseo",
      dataForSeoRelease,
      `backlink-snapshot:${domain}`
    ),
    targetUrl: observed(
      "https://elephtv.com/",
      "project_promotion_target",
      "promotion-target-v1",
      "promotion-target:elephtv"
    ),
    anchorText: unavailable(
      "dataforseo",
      dataForSeoRelease,
      `backlink-snapshot:${domain}`
    ),
    rel: unavailable(
      "dataforseo",
      dataForSeoRelease,
      `backlink-snapshot:${domain}`
    ),
    verification: null,
  }
}

export const initialRecommendations: readonly Recommendation[] = [
  {
    id: "018f0000-0000-7000-8000-000000000001",
    domain: "streamingbetter.com",
    score: 91,
    relevance: "流媒体媒体",
    contactability: "公开编辑邮箱",
    assessment: currentAssessment("streamingbetter.com", 91),
  },
  {
    id: "018f0000-0000-7000-8000-000000000002",
    domain: "cordcuttersnews.com",
    score: 86,
    relevance: "行业新闻",
    contactability: "投稿入口",
    assessment: currentAssessment("cordcuttersnews.com", 86),
  },
  {
    id: "018f0000-0000-7000-8000-000000000003",
    domain: "smarttvclub.net",
    score: 82,
    relevance: "Smart TV 博客",
    contactability: "待补联系人",
    assessment: currentAssessment("smarttvclub.net", 82),
  },
  {
    id: "018f0000-0000-7000-8000-000000000004",
    domain: "homecinemalist.com",
    score: 78,
    relevance: "家庭娱乐",
    contactability: "合作页面",
    assessment: legacyAssessment("homecinemalist.com", 78),
  },
]

const opportunitySeeds = [
  {
    id: "018f0000-0000-7000-8000-000000000011",
    domain: "watchwise.io",
    joinSequence: 11,
    businessStage: "JOINED",
    managementStatus: "ACTIVE",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 1,
    emailStatus: "not_started",
    contact: "—",
    score: 81,
    nextStep: "补充联系人",
    updated: "今天 09:18",
  },
  {
    id: "018f0000-0000-7000-8000-000000000012",
    domain: "tvguidehub.com",
    joinSequence: 12,
    businessStage: "READY_TO_CONTACT",
    managementStatus: "ACTIVE",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 3,
    emailStatus: "ready",
    contact: "editor@tvguidehub.com",
    score: 88,
    nextStep: "生成开发信",
    updated: "今天 08:42",
  },
  {
    id: "018f0000-0000-7000-8000-000000000013",
    domain: "streamscope.co",
    joinSequence: 13,
    businessStage: "READY_TO_CONTACT",
    managementStatus: "PAUSED",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 2,
    emailStatus: "draft",
    contact: "maya@streamscope.co",
    score: 77,
    nextStep: "确认发送",
    updated: "昨天",
  },
  {
    id: "018f0000-0000-7000-8000-000000000014",
    domain: "homecinemalist.com",
    joinSequence: 14,
    businessStage: "OUTREACH_ACTIVE",
    managementStatus: "ACTIVE",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 4,
    emailStatus: "sent_waiting_reply",
    contact: "hello@homecinemalist.com",
    score: 78,
    nextStep: "2 天后跟进",
    updated: "7月19日",
  },
  {
    id: "018f0000-0000-7000-8000-000000000015",
    domain: "streamerfocus.com",
    joinSequence: 15,
    businessStage: "NEGOTIATING",
    managementStatus: "ARCHIVED",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 5,
    emailStatus: "replied",
    contact: "partnerships@streamerfocus.com",
    score: 74,
    nextStep: "查看回复",
    updated: "18 分钟前",
  },
] as const

export const initialOpportunities: readonly Opportunity[] =
  opportunitySeeds.map((seed, index) => {
    const assessment =
      seed.domain === "homecinemalist.com"
        ? legacyAssessment(seed.domain, seed.score)
        : currentAssessment(seed.domain, seed.score)
    const assessmentRun = createAssessmentView(
      seed.id,
      assessment,
      seed.domain === "streamscope.co"
        ? {
            status: "FAILED",
            isCurrent: false,
            errorCode: "EVIDENCE_SOURCE_UNAVAILABLE",
          }
        : undefined
    )
    const draftFoundation =
      seed.emailStatus === "draft"
        ? createLocalDemoDraftFoundation()
        : seed.emailStatus === "sent_waiting_reply" ||
            seed.emailStatus === "replied"
          ? createLocalDemoDraftFoundation("sent", 2)
          : createDisabledDraftFoundation()
    return {
      ...seed,
      assessment,
      assessmentRun,
      draftFoundation,
      placementCandidate: createDomainPlacementCandidate(
        `placement-candidate-${index + 1}`,
        seed.id,
        seed.domain
      ),
    }
  })
