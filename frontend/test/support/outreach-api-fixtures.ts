import type { Page, Route } from "@playwright/test"

import type { BacklinksResponse } from "@/api/generated/backlinks"

type RecommendationInventoryResponse =
  BacklinksResponse<"backlinksGetRecommendationInventoryV1">
type RecommendationListItem =
  BacklinksResponse<"backlinksListRecommendationsV1">["items"][number]

export const outreachFixture = {
  projectKey: "e2e-project",
  recommendationId: "recommendation-e2e",
  opportunityId: "opportunity-e2e",
  prospectId: "prospect-e2e",
  contactId: "contact-e2e",
  draftId: "draft-e2e",
  draftVersionId: "draft-version-e2e",
  sendIntentId: "send-intent-e2e",
  reconciliationSendIntentId: "send-intent-reconciliation-e2e",
  sendSnapshotId: "send-snapshot-e2e",
  reconciliationSendSnapshotId: "send-snapshot-reconciliation-e2e",
  sendAttemptId: "send-attempt-e2e",
  reconciliationSendAttemptId: "send-attempt-reconciliation-e2e",
  messageId: "message-e2e",
  threadId: "thread-e2e",
  inboundMessageId: "inbound-message-e2e",
  replyCandidateId: "reply-candidate-e2e",
  placementId: "placement-e2e",
  now: "2026-07-30T00:00:00.000Z",
} as const

const {
  projectKey,
  recommendationId,
  opportunityId,
  prospectId,
  contactId,
  draftId,
  draftVersionId,
  sendIntentId,
  reconciliationSendIntentId,
  sendSnapshotId,
  reconciliationSendSnapshotId,
  sendAttemptId,
  reconciliationSendAttemptId,
  messageId,
  threadId,
  inboundMessageId,
  replyCandidateId,
  placementId,
  now,
} = outreachFixture

const meta = {
  organizationId: "organization-e2e",
  workspaceId: "workspace-e2e",
  websiteProjectId: projectKey,
  requestId: "request-e2e",
  schemaVersion: "backlinks.v1",
  generatedAt: now,
}

const sendReadinessSnapshot = {
  schemaVersion: "gmail-send-readiness.v1",
  policyVersion: "gmail-send-policy.v1",
  snapshotVersion:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evaluatedAt: now,
  expiresAt: "2026-12-31T00:00:00.000Z",
  conditions: [
    { code: "DRAFT_APPROVAL", revision: "draft-approval-e2e" },
    { code: "CONTACT_VERSION", revision: "contact-version-e2e" },
    { code: "GMAIL_BINDING", revision: "gmail-binding-e2e" },
    { code: "GMAIL_IDENTITY", revision: "gmail-identity-e2e" },
    { code: "SUPPRESSION", revision: "suppression-e2e" },
    { code: "KILL_SWITCH", revision: "kill-switch-e2e" },
    { code: "COOLDOWN", revision: "cooldown-e2e" },
    { code: "QUOTA", revision: "quota-e2e" },
  ],
} as const

const assessment = {
  outcome: "low_risk",
  score: 92,
  availability: "available",
  freshness: "fresh",
  scoreModelVersion: "score-model-e2e",
  ruleVersion: "rule-e2e",
  generatedAt: now,
  readOnly: true,
  sourceReleaseIds: [],
  unavailableFields: [],
  staleFields: [],
  components: [
    {
      id: "topic_content_editorial_quality",
      normalizedValue: 0.92,
      weight: 1,
      points: 92,
      availability: "observed",
      sourceType: "e2e-fixture",
      sourceReleaseId: "release-e2e",
      confidence: 1,
      observedAt: now,
      stale: false,
      evidenceRefs: [],
      unavailableReason: null,
      derivationRuleVersion: null,
    },
  ],
}

const recommendationContextVersionId = "018f0000-0000-7000-8000-000000000401"
const recommendationJobId = "018f0000-0000-7000-8000-000000000402"
const recommendationBatchId = "018f0000-0000-7000-8000-000000000403"

const recommendationListItem: RecommendationListItem = {
  id: recommendationId,
  hostname: "publisher.example.test",
  score: 92,
  status: "ready",
  contractKind: "corrected_visibility_v1",
  outreachReadiness: "ready",
  priority: "high",
  candidateSource: "paid_discovery",
  resourceType: null,
  metricsSource: "dataforseo",
  risk: {
    level: "low",
    spamScore: 4,
  },
  relevantPages: ["https://publisher.example.test/publisher-outreach-guide"],
  emailSource: {
    url: "https://publisher.example.test/contact",
    extractionMethod: "visible_text",
    observedAt: now,
  },
  publicationStatus: "PUBLISHED",
  verifiedPublicEmailCount: 1,
  recommendationContextVersionId,
  version: 1,
  scoreModelVersion: "recommendation-commercial-fit.v3",
  ruleVersion: "recommendation-commercial-fit-rules.v3.2",
  fitDecision: {
    decision: "eligible",
    matchTier: "high_fit",
    overallFit: 92,
    scoreModelVersion: "recommendation-commercial-fit.v3",
    ruleVersion: "recommendation-commercial-fit-rules.v3.2",
    reasonCodes: ["PRODUCT_MATCH", "TOPIC_MATCH", "TARGET_MARKET_MATCH"],
    matchedProducts: ["E2E product"],
    matchedTopics: ["publisher outreach"],
    matchedKeywords: ["publisher outreach"],
    matchedTargetPages: ["https://owner.example.test/guide"],
    matchedAudiences: ["site owners"],
    market: {
      targetCountry: "US",
      candidateCountry: "US",
      targetLanguage: "en",
      candidateLanguage: "en",
      tier: "target_market",
      reasonCode: "TARGET_MARKET_MATCH",
    },
    cooperationAngles: ["editorial resource placement"],
    dataForSeo: {
      rank: 320,
      traffic: 12_500,
      backlinks: 4_200,
      referringDomains: 780,
      spamScore: 4,
      evidenceRefs: ["dataforseo:publisher.example.test"],
      collectedAt: now,
    },
    safeFetch: {
      relatedContentPages: [
        "https://publisher.example.test/publisher-outreach-guide",
      ],
      evidenceUrls: ["https://publisher.example.test/publisher-outreach-guide"],
      evidenceRefs: ["safefetch:publisher.example.test"],
      failedUrls: [],
      technicalAccessibility: 0.95,
    },
    components: [
      {
        id: "semantic_relevance",
        state: "observed",
        rawValue: 0.95,
        normalizedValue: 0.95,
        weight: 30,
        points: 28.5,
        evidenceRefs: ["fit:publisher.example.test:semantic"],
        normalizationRuleVersion: "recommendation-commercial-fit-rules.v3.2",
        collectedAt: now,
      },
    ],
  },
  contactDecision: {
    decision: "eligible",
    reasonCode: "PUBLIC_EMAIL_FOUND",
    sourceUrl: "https://publisher.example.test/contact",
    inferredPurpose: "editorial",
    contactConfidence: 95,
    purposeConfidence: 95,
    evidenceConfidence: 95,
    collectedAt: now,
    rulesVersion: "contact-publication-rules.v2",
  },
  cooperationPath: null,
  rootUrl: "https://publisher.example.test/",
  faviconUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  acquiredAt: now,
  contactStatus: "contactable",
  contactJob: {
    id: "contact-job-e2e",
    batchId: recommendationBatchId,
    status: "completed",
    candidateCount: 1,
    evidenceCount: 1,
    pagesVisited: 3,
    lastErrorCode: null,
    terminalReasonCode: "PUBLIC_EMAIL_FOUND",
    method: "static",
    lastErrorCategory: null,
    retryAfter: null,
    completedAt: now,
  },
  contacts: [
    {
      id: "contact-candidate-e2e",
      normalizedEmail: "editor@publisher.example.test",
      domainRelation: "same_registrable_domain",
      confidence: 95,
      inferredPurpose: "editorial",
      purposeConfidence: 95,
      guessed: false,
      version: 1,
      eligible: true,
      contactReviewRequired: false,
      evidence: [
        {
          id: "contact-evidence-e2e",
          sourceUrl: "https://publisher.example.test/contact",
          observedAt: now,
          extractionMethod: "visible_text",
          evidenceSnippet: "editor@publisher.example.test",
          confidence: 95,
        },
      ],
    },
  ],
  recommendedContactCandidateId: "contact-candidate-e2e",
  existingOpportunityId: null,
  canCreateOpportunity: true,
  createBlockReason: null,
}

const opportunityListItem = {
  id: opportunityId,
  targetSiteKey: "publisher.example.test",
  targetHostAscii: "publisher.example.test",
  joinSequence: 1,
  businessStage: "READY_TO_CONTACT",
  managementStatus: "ACTIVE",
  outcomeStatus: "OPEN",
  fulfillmentStatus: "NOT_EXPECTED",
  engagementChannel: "EMAIL",
  sourceContactCandidateId: "contact-candidate-e2e",
  contactEmail: "editor@publisher.example.test",
  contactReviewRequired: false,
  manualActionState: null,
  hasDownstreamFacts: false,
  version: 3,
  createdAt: now,
  updatedAt: now,
}

const mailListItem = {
  id: messageId,
  threadId,
  direction: "INBOUND",
  fromAddress: "reply@publisher.example.test",
  toAddresses: ["owner@example.test"],
  ccAddresses: [],
  subject: "Re: E2E collaboration",
  receivedAt: now,
  parseStatus: "PARSED",
  version: 2,
  inboundMessageId,
  matchStatus: "CANDIDATES_READY",
  matchedOpportunityId: null,
}

const mailDetailItem = {
  ...mailListItem,
  body: {
    plainText: "Please share pricing for the proposed placement.",
    sanitizedHtml: null,
  },
}

const placementListItem = {
  recordType: "placement",
  displayState: "confirmed",
  placementId,
  candidateId: "placement-candidate-e2e",
  opportunityId,
  replyId: inboundMessageId,
  lineageStatus: "OUTREACH_DERIVED",
  sourcePageUrl: "https://publisher.example.test/article",
  targetUrl: "https://owner.example.test/guide",
  initialValidationStatus: "VERIFIED",
  healthStatus: "HEALTHY",
  monitoringState: "active",
  monitoringStatus: "ACTIVE",
  latestObservedAt: now,
  lastSuccessfulObservationAt: now,
  nextCheckAt: "2026-08-29T00:00:00.000Z",
  freshness: "stale",
  latestFailure: {
    status: "failed",
    code: "provider_timeout",
  },
  evidenceSource: "DIRECT_MONITOR",
  version: 4,
  createdAt: now,
  countsTowardKpi: true,
}

const negotiationFact = {
  id: "negotiation-fact-e2e-v1",
  inboundMessageId,
  opportunityId,
  factKey: "commercial.price",
  factVersion: 1,
  factType: "PRICE",
  rawValue: "ZAR 7,500",
  normalizedValue: { currency: "ZAR", amount: 7_500 },
  factAuthority: "INFERRED",
  reviewStatus: "PENDING",
  extractorType: "RULE",
  extractorVersion: "negotiation-rule-e2e",
  confidenceScore: 0.86,
  evidenceText: "The placement fee is ZAR 7,500.",
  evidenceStart: 21,
  evidenceEnd: 30,
  supersedesFactVersionId: null,
  decidedBy: null,
  decidedAt: null,
  schemaVersion: 1,
  createdAt: now,
  createdBy: "gmail-sync-e2e",
} as const

const profileInventory = Array.from({ length: 42 }, (_, index) => {
  const itemNumber = index + 1
  const sourceType = itemNumber % 9 === 0 ? "USER_IMPORTED" : "DATAFORSEO"
  const providerStatus =
    itemNumber % 7 === 0 ? "lost" : itemNumber % 11 === 0 ? "unknown" : "live"
  return {
    inventoryItemId: `inventory-e2e-${itemNumber}`,
    sourceType,
    provider: sourceType === "DATAFORSEO" ? "dataforseo" : "user_import",
    sourceDomain: `source-${itemNumber}.publisher.example.test`,
    sourceUrl: `https://source-${itemNumber}.publisher.example.test/article`,
    targetUrl: "https://owner.example.test/guide",
    anchorText: itemNumber % 3 === 0 ? "owner guide" : `anchor ${itemNumber}`,
    relAttributes: itemNumber % 4 === 0 ? ["nofollow"] : ["dofollow"],
    providerStatus,
    firstSeenAt: `2026-07-${String((itemNumber % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
    lastSeenAt: now,
    rank: 100 - itemNumber,
    spamScore: itemNumber,
    countryCode: itemNumber % 2 === 0 ? "US" : "GB",
    tld: "test",
    languageCode: "en",
    sourceHttpStatus: providerStatus === "lost" ? 404 : 200,
    targetHttpStatus: 200,
    redirectUrl: null,
    placementId: itemNumber === 1 ? placementId : null,
    opportunityId: itemNumber === 2 ? opportunityId : null,
    pinned: itemNumber === 2,
    managed: itemNumber === 1,
    directHealthStatus:
      itemNumber === 14
        ? "lost"
        : itemNumber === 7
          ? "suspected_lost"
          : itemNumber === 1
            ? "active"
            : "pending_verification",
    directValidationStatus:
      itemNumber === 14
        ? "LOST"
        : itemNumber === 7
          ? "SUSPECTED_LOST"
          : itemNumber === 1
            ? "VALID"
            : itemNumber === 11
              ? "INACCESSIBLE"
              : "UNVERIFIED",
    lastDirectCheckedAt: itemNumber === 1 ? now : null,
    restrictionReason: itemNumber === 11 ? "login_required" : null,
    userNotes: itemNumber === 9 ? "Imported by owner" : null,
    latestDirectEvidenceId:
      itemNumber === 1 ? "inventory-observation-e2e-1" : null,
    tier:
      itemNumber === 1 || itemNumber === 2
        ? "A"
        : 100 - itemNumber >= 60
          ? "B"
          : "C",
    importance: itemNumber === 1 ? "important" : "normal",
    monitoringStatus: itemNumber === 2 ? "paused" : "enabled",
    policyVersion: "inventory-monitoring-v1",
    policyRevision: 1,
    nextCheckAt: itemNumber === 2 ? null : "2026-08-06T12:00:00.000Z",
    providerOnlyReason: null,
  }
})

export type CapturedRequest = {
  method: string
  pathname: string
  body: unknown
  idempotencyKey: string | undefined
}

export type OutreachApiFixtureSession = {
  capturedRequests: CapturedRequest[]
  unexpectedNetwork: string[]
}

export type OutreachApiFixtureOptions = Readonly<{
  contactMode?: "single" | "multiple" | "none"
  gmailMode?: "selected" | "reusable"
  performanceBacklinksMode?: "fresh" | "provider_failed"
  recommendationMode?: "ready" | "generate"
  recommendationCompleteAfterReads?: number
  recommendationPoolSize?: number
  draftJobStatuses?: readonly (
    "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "REFUSED"
  )[]
}>

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}

export async function installOutreachApiFixtures(
  page: Page,
  options: OutreachApiFixtureOptions = {}
): Promise<OutreachApiFixtureSession> {
  const capturedRequests: CapturedRequest[] = []
  const unexpectedNetwork: string[] = []
  const contactMode = options.contactMode ?? "single"
  const gmailMode = options.gmailMode ?? "selected"
  const performanceBacklinksMode =
    options.performanceBacklinksMode ?? "provider_failed"
  const recommendationMode = options.recommendationMode ?? "ready"
  const recommendationCompleteAfterReads =
    options.recommendationCompleteAfterReads ?? 3
  const recommendationPoolSize =
    options.recommendationPoolSize ??
    (recommendationMode === "generate" ? 20 : 1)
  const draftJobStatuses = options.draftJobStatuses ?? ["SUCCEEDED"]
  const draftQueuedAt = new Date().toISOString()
  const draftDeadlineAt = new Date(
    Date.parse(draftQueuedAt) + 120_000
  ).toISOString()
  let draftApproved = false
  let draftJobStatusReads = 0
  let latestDraftJobStatus:
    "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "REFUSED" | null = null
  let draftFinishedAt: string | null = null
  let sendIntentStatusReads = 0
  let recommendationRefillRequested = recommendationMode === "ready"
  let recommendationInventoryReads = 0
  let recommendationAvailable = recommendationMode === "ready"
  let visiblePoolGeneration = 1
  let visiblePoolState: RecommendationInventoryResponse["visiblePoolState"] =
    recommendationMode === "ready" ? "active" : "idle"
  let archivedVisiblePoolCount = 0
  let visiblePoolArchivedAt: string | null = null
  let recommendationStartedAt = new Date(Date.now() - 125_000).toISOString()
  let manualCandidateCreated = false
  let manualContactConfirmed = false
  let opportunityManagementStatus: "ACTIVE" | "PAUSED" | "ARCHIVED" = "ACTIVE"
  let opportunityVersion = opportunityListItem.version
  let selectedGmailConnectionId =
    gmailMode === "selected" ? "gmail-connection-e2e" : null
  let negotiationFacts: Array<Record<string, unknown>> = [negotiationFact]
  const agentConversation = {
    id: "agent-conversation-e2e",
    project_id: projectKey,
    title: "Project assistant",
    created_at: now,
    updated_at: now,
  }
  const gmailAccount = {
    connectionId: "gmail-connection-e2e",
    version: 1,
    primaryEmail: "owner@example.test",
    displayName: "Owner",
    hostedDomain: "example.test",
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    connectionStatus: "CONNECTED",
    sendAvailability: "AVAILABLE",
    mailSyncCapability: true,
    tokenExpiresAt: "2026-08-06T09:00:00.000Z",
    connectedAt: now,
    affectedProjectCount: 1,
    recentErrorCategory: null,
  }
  const gmailReadiness = () =>
    selectedGmailConnectionId === gmailAccount.connectionId
      ? {
          evaluatedAt: now,
          connection: { state: "CONNECTED", ready: true },
          send: { state: "WAITING_FOR_SEND_CONTEXT", ready: false },
          sync: { state: "SYNC_READY", ready: true },
          blockers: [
            {
              code: "SEND_CONTEXT_REQUIRED",
              capability: "SEND",
              owner: "USER",
              retrySafe: true,
              recoveryAction: "OPEN_APPROVED_DRAFT",
              detail:
                "Open an approved draft and recipient to evaluate send-specific readiness.",
            },
          ],
          primaryBlocker: {
            code: "SEND_CONTEXT_REQUIRED",
            capability: "SEND",
            owner: "USER",
            retrySafe: true,
            recoveryAction: "OPEN_APPROVED_DRAFT",
            detail:
              "Open an approved draft and recipient to evaluate send-specific readiness.",
          },
        }
      : {
          evaluatedAt: now,
          connection: { state: "NOT_CONNECTED", ready: false },
          send: { state: "BLOCKED", ready: false },
          sync: { state: "BLOCKED", ready: false },
          blockers: [
            {
              code: "GMAIL_ACCOUNT_NOT_SELECTED",
              capability: "CONNECTION",
              owner: "USER",
              retrySafe: true,
              recoveryAction: "SELECT_GMAIL_ACCOUNT",
              detail: "Select or connect a Gmail account for this project.",
            },
          ],
          primaryBlocker: {
            code: "GMAIL_ACCOUNT_NOT_SELECTED",
            capability: "CONNECTION",
            owner: "USER",
            retrySafe: true,
            recoveryAction: "SELECT_GMAIL_ACCOUNT",
            detail: "Select or connect a Gmail account for this project.",
          },
        }
  const currentOpportunityListItem = () => ({
    ...opportunityListItem,
    managementStatus: opportunityManagementStatus,
    version: opportunityVersion,
    updatedAt: new Date().toISOString(),
  })
  const recommendationJobIdForGeneration = () =>
    visiblePoolGeneration === 1
      ? recommendationJobId
      : `018f0000-0000-7000-8000-${String(410 + visiblePoolGeneration).padStart(12, "0")}`
  const recommendationBatchIdForGeneration = () =>
    visiblePoolGeneration === 1
      ? recommendationBatchId
      : `018f0000-0000-7000-8000-${String(430 + visiblePoolGeneration).padStart(12, "0")}`
  const recommendationPoolItem = (
    generation: number,
    itemNumber: number
  ): RecommendationListItem => {
    if (generation === 1 && itemNumber === 1) return recommendationListItem
    const hostname = `publisher-g${generation}-${String(itemNumber).padStart(2, "0")}.example.test`
    const itemId = `recommendation-e2e-g${generation}-${itemNumber}`
    const candidateId = `contact-candidate-e2e-g${generation}-${itemNumber}`
    const contactUrl = `https://${hostname}/contact`
    const contentUrl = `https://${hostname}/publisher-outreach-guide`
    const normalizedEmail = `editor-${generation}-${itemNumber}@${hostname}`
    return {
      ...recommendationListItem,
      id: itemId,
      hostname,
      relevantPages: [contentUrl],
      emailSource: {
        ...recommendationListItem.emailSource,
        url: contactUrl,
      },
      fitDecision: {
        ...recommendationListItem.fitDecision,
        matchedProducts: [`E2E product ${generation}-${itemNumber}`],
        dataForSeo: {
          ...recommendationListItem.fitDecision.dataForSeo,
          evidenceRefs: [`dataforseo:${hostname}`],
        },
        safeFetch: {
          ...recommendationListItem.fitDecision.safeFetch,
          relatedContentPages: [contentUrl],
          evidenceUrls: [contentUrl],
          evidenceRefs: [`safefetch:${hostname}`],
        },
        components: recommendationListItem.fitDecision.components.map(
          (component) => ({
            ...component,
            evidenceRefs: [`fit:${hostname}:semantic`],
          })
        ),
      },
      contactDecision: {
        ...recommendationListItem.contactDecision,
        sourceUrl: contactUrl,
      },
      rootUrl: `https://${hostname}/`,
      contactJob: recommendationListItem.contactJob
        ? {
            ...recommendationListItem.contactJob,
            id: `contact-job-e2e-g${generation}-${itemNumber}`,
            batchId: recommendationBatchIdForGeneration(),
          }
        : null,
      contacts: recommendationListItem.contacts.map((contact) => ({
        ...contact,
        id: candidateId,
        normalizedEmail,
        evidence: contact.evidence.map((evidence) => ({
          ...evidence,
          id: `contact-evidence-e2e-g${generation}-${itemNumber}`,
          sourceUrl: contactUrl,
          evidenceSnippet: normalizedEmail,
        })),
      })),
      recommendedContactCandidateId: candidateId,
      existingOpportunityId: null,
      canCreateOpportunity: true,
      createBlockReason: null,
    }
  }
  const currentRecommendationItems = () =>
    recommendationAvailable
      ? Array.from({ length: recommendationPoolSize }, (_, index) =>
          recommendationPoolItem(visiblePoolGeneration, index + 1)
        )
      : []
  const draftJob = (status: Exclude<typeof latestDraftJobStatus, null>) => {
    const started = status !== "QUEUED"
    const terminal =
      status === "SUCCEEDED" || status === "FAILED" || status === "REFUSED"
    if (terminal && draftFinishedAt === null) {
      draftFinishedAt = new Date().toISOString()
    }
    return {
      id: "draft-job-e2e",
      draftId,
      status,
      contactId,
      contactVersion: 1,
      requestSnapshotId: "draft-request-snapshot-e2e",
      request: {
        cooperationType: "GENERAL_PARTNERSHIP",
        linkAttributePreference: "NOT_SPECIFIED",
        promotionTargetUrl: "https://owner.example.test/guide",
        anchorTextSuggestion: null,
        language: "en",
        tone: "NEUTRAL_BUSINESS",
        subjectStyle: "CLEAR_DIRECT",
        additionalRequirements: "",
        forbiddenPhrases: [],
      },
      generator: status === "SUCCEEDED" ? "AI" : null,
      versionId: status === "SUCCEEDED" ? draftVersionId : null,
      lastSuccessfulVersionId: status === "SUCCEEDED" ? draftVersionId : null,
      queuedAt: draftQueuedAt,
      startedAt: started ? draftQueuedAt : null,
      finishedAt: terminal ? draftFinishedAt : null,
      deadlineAt: draftDeadlineAt,
      queueWaitMs: started ? 0 : null,
      latencyMs: terminal ? 1_800 : null,
      persistenceLatencyMs: terminal ? 15 : null,
      attemptCount: started ? 1 : 0,
      lastErrorCategory:
        status === "FAILED" || status === "REFUSED" ? "E2E_FAILURE" : null,
      readiness:
        status === "QUEUED"
          ? "QUEUED"
          : status === "RUNNING"
            ? "GENERATING"
            : status === "RETRY_SCHEDULED"
              ? "RETRYING"
              : status === "SUCCEEDED"
                ? "AI_DRAFT_READY"
                : status === "REFUSED"
                  ? "POLICY_BLOCKED"
                  : "FAILED",
      fallbackReason: null,
    }
  }

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const pathname = url.pathname

    if (pathname.startsWith("/api/v1/")) {
      capturedRequests.push({
        method,
        pathname,
        body: request.postData() ? request.postDataJSON() : null,
        idempotencyKey: request.headers()["idempotency-key"],
      })

      if (method === "GET" && pathname === "/api/v1/runtime-status") {
        return json(route, {
          status: "ok",
          business_consumers_running: true,
        })
      }

      if (method === "GET" && pathname === "/api/v1/projects") {
        return json(route, [
          {
            id: projectKey,
            workspace_id: "workspace-e2e",
            lifecycle_status: "ACTIVE",
            lifecycle_version: 1,
            archived_at: null,
            archive_reason: null,
            context_version: 1,
            name: "E2E Project",
            domain: "owner.example.test",
            country: "US",
            language: "en",
            competitor_domain: null,
            understanding_run_id: "understanding-run-e2e",
            understanding_status: "completed",
            understanding_stage: "completed",
            understanding_message: "Website understanding completed.",
            understanding_progress: 100,
            understanding_attempt: 1,
            understanding_started_at: "2026-08-05T00:00:00.000Z",
            understanding_finished_at: "2026-08-05T00:01:00.000Z",
            understanding_elapsed_seconds: 60,
            audit_run_id: "audit-run-e2e",
            audit_status: "completed",
            audit_health: 100,
            site_profile: {
              profile_version: 1,
              extraction_method: "e2e_fixture",
              source_page_count: 1,
              favicon_url: "/favicon.ico",
              business_name: "E2E Project",
              business_type: "Publisher services",
              business_summary: "E2E publisher outreach project.",
              products_services: ["E2E product"],
              target_audiences: ["site owners"],
              value_propositions: ["Editorial resource placement"],
              use_cases: ["Publisher outreach"],
              target_markets: ["United States"],
              languages: ["en"],
              content_topics: ["publisher outreach"],
              conversion_actions: ["Contact publisher"],
              key_pages: [
                {
                  url: "https://owner.example.test/guide",
                  title: "Owner guide",
                  description: "Primary promotion target.",
                },
              ],
              evidence: [],
              user_overridden_fields: [],
              confidence: 1,
              ai_content_rules: "Use concise professional language.",
              confirmed_at: "2026-08-05T00:02:00.000Z",
            },
            created_at: "2026-08-05T00:00:00.000Z",
          },
        ])
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/onboarding`
      ) {
        return json(route, {
          id: "onboarding-e2e",
          project_id: projectKey,
          status: "completed",
          started_at: now,
          business_confirmed_at: now,
          completed_at: now,
          steps: [],
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/agent/conversations`
      ) {
        return json(route, {
          items: [agentConversation],
          total: 1,
          page: 1,
          page_size: 20,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/agent/conversations/${agentConversation.id}`
      ) {
        return json(route, {
          conversation: agentConversation,
          messages: [],
          timeline: [],
          run: null,
          action: null,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/agent/conversations/${agentConversation.id}/events`
      ) {
        return route.fulfill({ status: 204 })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/audit-runs/audit-run-e2e`
      ) {
        return json(route, {
          run_id: "audit-run-e2e",
          project_id: projectKey,
          status: "completed",
          stage: "completed",
          message: "Audit completed.",
          progress: 100,
          discovered: 1,
          processed: 1,
          selected: 1,
          created_at: now,
          completed_at: now,
          can_resume: false,
          archived_at: null,
          summary: {
            page_count: 1,
            health_score: 100,
            errors: 0,
            warnings: 0,
            notices: 0,
            rendered_pages: 0,
            resource_checks_truncated: false,
          },
          pagespeed: null,
          issue_exclusion_patterns: [],
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/context`
      ) {
        return json(route, {
          actor: {
            userId: "user-e2e",
            sessionId: "session-e2e",
            roles: ["owner"],
          },
          tenant: {
            organizationId: meta.organizationId,
            workspaceId: meta.workspaceId,
          },
          project: {
            websiteProjectId: projectKey,
            canonicalDomain: "owner.example.test",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-e2e",
            promotionTargetVersionId: "promotion-target-e2e",
          },
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/recommendations`
      ) {
        return json(route, {
          items: currentRecommendationItems(),
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/recommendation-inventory`
      ) {
        if (
          recommendationRefillRequested &&
          visiblePoolState === "building" &&
          !recommendationAvailable
        ) {
          recommendationInventoryReads += 1
          recommendationAvailable =
            recommendationInventoryReads >= recommendationCompleteAfterReads
          if (recommendationAvailable) visiblePoolState = "active"
        }
        const running =
          recommendationRefillRequested &&
          visiblePoolState === "building" &&
          !recommendationAvailable
        const contactRunning = running && recommendationInventoryReads >= 2
        const serverUpdatedAt = recommendationRefillRequested
          ? new Date().toISOString()
          : now
        const inventoryResponse: RecommendationInventoryResponse = {
          contractVersion: "backlinks.recommendation-operation.v1",
          contractKind: "corrected_visibility_v1",
          productState: "running",
          productStateReason: recommendationAvailable
            ? "VISIBLE_TARGET_REACHED"
            : running
              ? "REFILL_IN_PROGRESS"
              : "READY_TO_CONTINUE",
          recoveryCommand: recommendationAvailable
            ? null
            : "CONTINUE_SAME_CRITERIA",
          providerAvailability: "available",
          visibleMatchCount: recommendationAvailable
            ? recommendationPoolSize
            : 0,
          activeProcessingSeconds: recommendationRefillRequested ? 125 : 0,
          providerBalanceMicros: null,
          aiCapacity: {
            status: "unconfigured",
            remainingCalls: null,
            remainingBudgetMicros: null,
          },
          runningBuildId: "local-product-e2e-fixture",
          visiblePoolGeneration,
          visiblePoolState,
          visiblePoolTargetCount: 20,
          archivedVisiblePoolCount,
          visiblePoolArchivedAt,
          operationId: recommendationRefillRequested
            ? recommendationJobIdForGeneration()
            : null,
          jobId: recommendationRefillRequested
            ? recommendationJobIdForGeneration()
            : null,
          stage: recommendationAvailable
            ? "complete"
            : contactRunning
              ? "contact"
              : recommendationRefillRequested
                ? "discovery"
                : "blueprint",
          terminal: recommendationAvailable,
          terminalState: recommendationAvailable ? "TARGET_REACHED" : null,
          targetCount: 20,
          rawCount: recommendationRefillRequested
            ? recommendationAvailable
              ? 40
              : 3
            : 0,
          fitCount: recommendationRefillRequested
            ? recommendationAvailable
              ? 28
              : 3
            : 0,
          contactCount: recommendationAvailable ? recommendationPoolSize : 0,
          publishedCount: recommendationAvailable ? recommendationPoolSize : 0,
          unpublishedCount: recommendationRefillRequested
            ? recommendationAvailable
              ? 0
              : 3
            : 0,
          tier: "exact_product_target_market",
          round: 1,
          window: 1,
          paidCursor: recommendationRefillRequested
            ? {
                tier: "exact_product_target_market",
                round: 1,
                window: 1,
              }
            : null,
          resourceCursor: null,
          nextRetryAt: null,
          errorCode: null,
          recoveryAction: null,
          providerCallOccurred: false,
          recommendationContextVersionId,
          serverUpdatedAt,
          candidateReadyCount: recommendationRefillRequested
            ? recommendationAvailable
              ? 28
              : 3
            : 0,
          publishedContactReadyCount: recommendationAvailable
            ? recommendationPoolSize
            : 0,
          rawCandidateCount: recommendationRefillRequested
            ? recommendationAvailable
              ? 40
              : 3
            : 0,
          historicalEmailHitRate: recommendationAvailable ? 1 : 0.1,
          candidateLowWatermark: 20,
          candidateHighWatermark: 40,
          publishedLowWatermark: 20,
          publishedHighWatermark: 20,
          blueprintVersion: recommendationRefillRequested ? 1 : null,
          blueprintGenerator: recommendationRefillRequested
            ? "DETERMINISTIC_FALLBACK"
            : null,
          latestRefillAt: recommendationRefillRequested
            ? recommendationStartedAt
            : null,
          nextRefillAt: null,
          providerCollectedAt: recommendationRefillRequested
            ? recommendationStartedAt
            : null,
          pauseReason: null,
          refillInFlight: running,
          refillState: running
            ? contactRunning
              ? "waiting_contact"
              : "running"
            : recommendationAvailable
              ? "completed"
              : "idle",
          currentRefillTier: "exact_product_target_market",
          currentRefillRound: 1,
          attemptedRefillTiers: recommendationRefillRequested
            ? [
                {
                  tier: "exact_product_target_market",
                  round: 1,
                  window: 1,
                },
              ]
            : [],
          terminationReason: recommendationAvailable ? "HIGH_WATERMARK" : null,
          eliminationReasonCounts: [],
          refillJob: recommendationRefillRequested
            ? {
                operationId: recommendationJobIdForGeneration(),
                id: recommendationJobIdForGeneration(),
                workflowId: `backlinks:recommendation-refill:e2e:g${visiblePoolGeneration}`,
                status: recommendationAvailable ? "success" : "running",
                step: recommendationAvailable
                  ? "completed"
                  : contactRunning
                    ? "contact_enrichment"
                    : "candidate_scoring",
                progress: recommendationAvailable
                  ? 100
                  : 20 + recommendationInventoryReads * 20,
                errorCode: null,
                errorMessage: null,
                failure: null,
                retryCount: 0,
                lowWatermark: 20,
                highWatermark: 40,
                refillWindowKey: `manual:e2e:g${visiblePoolGeneration}`,
                startedAt: recommendationStartedAt,
                finishedAt: recommendationAvailable ? serverUpdatedAt : null,
                createdAt: recommendationStartedAt,
                updatedAt: serverUpdatedAt,
                version: recommendationInventoryReads + 1,
              }
            : null,
          contactBatch:
            contactRunning || recommendationAvailable
              ? {
                  id: recommendationBatchIdForGeneration(),
                  status: recommendationAvailable ? "completed" : "running",
                  totalJobCount: recommendationAvailable
                    ? recommendationPoolSize
                    : 3,
                  terminalJobCount: recommendationAvailable
                    ? recommendationPoolSize
                    : Math.min(
                        3,
                        Math.max(1, recommendationInventoryReads - 1)
                      ),
                  publishedCount: recommendationAvailable
                    ? recommendationPoolSize
                    : 0,
                  unpublishedCount: recommendationAvailable ? 0 : 3,
                  retryableUnpublishedCount: 0,
                  nextRetryAt: null,
                  reasonCounts: recommendationAvailable
                    ? [
                        {
                          reasonCode: "PUBLIC_EMAIL_FOUND",
                          count: recommendationPoolSize,
                        },
                      ]
                    : [],
                  startedAt: recommendationStartedAt,
                  completedAt: recommendationAvailable ? serverUpdatedAt : null,
                }
              : null,
          meta,
        }
        return json(route, inventoryResponse)
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/recommendation-refill-jobs`
      ) {
        recommendationRefillRequested = true
        recommendationInventoryReads = 0
        recommendationAvailable = false
        visiblePoolState = "building"
        recommendationStartedAt = new Date(Date.now() - 125_000).toISOString()
        return json(
          route,
          {
            operationId: recommendationJobIdForGeneration(),
            jobId: recommendationJobIdForGeneration(),
            workflowId: `backlinks:recommendation-refill:e2e:g${visiblePoolGeneration}`,
            status: "queued",
            version: 1,
            lifecycleEventId: `lifecycle-recommendation-refill-e2e-g${visiblePoolGeneration}`,
            auditEventId: `audit-recommendation-refill-e2e-g${visiblePoolGeneration}`,
            replayed: false,
            meta: {
              ...meta,
              generatedAt: new Date().toISOString(),
            },
          },
          202
        )
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/recommendation-pools/${visiblePoolGeneration}/archive`
      ) {
        const archivedGeneration = visiblePoolGeneration
        const archivedCount = currentRecommendationItems().length
        archivedVisiblePoolCount += archivedCount
        visiblePoolArchivedAt = new Date().toISOString()
        visiblePoolGeneration += 1
        visiblePoolState = "awaiting_refresh"
        recommendationRefillRequested = false
        recommendationInventoryReads = 0
        recommendationAvailable = false
        return json(route, {
          archivedGeneration,
          nextGeneration: visiblePoolGeneration,
          archivedCount,
          state: "awaiting_refresh",
          version: archivedGeneration + 1,
          lifecycleEventId: `lifecycle-recommendation-archive-e2e-g${archivedGeneration}`,
          auditEventId: `audit-recommendation-archive-e2e-g${archivedGeneration}`,
          replayed: false,
          meta: {
            ...meta,
            generatedAt: new Date().toISOString(),
          },
        })
      }

      if (
        method === "POST" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/opportunities`
      ) {
        return json(
          route,
          {
            opportunityId,
            recommendationId,
            cycleId: "cycle-e2e",
            websiteProjectId: projectKey,
            targetSiteKey: "publisher.example.test",
            targetHostAscii: "publisher.example.test",
            contactCandidateId: "contact-candidate-e2e",
            contactReviewRequired: false,
            joinSequence: 2,
            businessStage: "JOINED",
            managementStatus: "ACTIVE",
            outcomeStatus: "OPEN",
            fulfillmentStatus: "NOT_EXPECTED",
            version: 1,
            lifecycleEventId: "lifecycle-opportunity-create-e2e",
            auditEventId: "audit-opportunity-create-e2e",
            replayed: false,
            meta,
          },
          201
        )
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/opportunities`
      ) {
        const managementStatus = url.searchParams.get("managementStatus")
        const matchesManagement =
          managementStatus === null
            ? opportunityManagementStatus !== "ARCHIVED"
            : managementStatus === opportunityManagementStatus
        const search = url.searchParams.get("search")?.toLowerCase() ?? ""
        const matchesSearch =
          search.length === 0 ||
          opportunityListItem.targetHostAscii.includes(search) ||
          opportunityListItem.contactEmail.includes(search)
        return json(route, {
          items:
            matchesManagement && matchesSearch
              ? [currentOpportunityListItem()]
              : [],
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}`
      ) {
        return json(route, {
          item: {
            ...currentOpportunityListItem(),
            recommendationId,
            prospectId,
            recommendationContextVersionId: "context-e2e",
            targetIdentityKind: "registrable_domain",
            targetIdentityRuleVersion: "identity-rule-e2e",
            targetIdentityOverrideReason: null,
            assessment,
            placementCandidate: null,
            cooperationPath: null,
          },
          meta,
        })
      }

      if (
        method === "PATCH" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/management`
      ) {
        const body = request.postDataJSON() as {
          expectedVersion: number
          managementStatus: "ACTIVE" | "PAUSED" | "ARCHIVED"
        }
        if (body.expectedVersion !== opportunityVersion) {
          return json(
            route,
            {
              code: "BACKLINK_VERSION_CONFLICT",
              detail: "Opportunity version changed.",
            },
            409
          )
        }
        opportunityManagementStatus = body.managementStatus
        opportunityVersion += 1
        return json(route, {
          opportunityId,
          businessStage: opportunityListItem.businessStage,
          managementStatus: opportunityManagementStatus,
          outcomeStatus: opportunityListItem.outcomeStatus,
          fulfillmentStatus: opportunityListItem.fulfillmentStatus,
          version: opportunityVersion,
          lifecycleEventId: `lifecycle-management-${opportunityVersion}`,
          auditEventId: `audit-management-${opportunityVersion}`,
          replayed: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/assessments/${opportunityId}`
      ) {
        return json(route, {
          assessment: {
            run: {
              id: "assessment-run-e2e",
              opportunityId,
              status: "SUCCEEDED",
              attemptCount: 1,
              sourceReleaseIds: [],
              startedAt: now,
              finishedAt: now,
              errorCode: null,
            },
            result: {
              snapshotId: "assessment-snapshot-e2e",
              snapshotVersion: 1,
              isCurrent: true,
              availability: "available",
              stale: false,
              sourceReleaseIds: [],
              generatedAt: now,
              payload: {},
            },
          },
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/draft-jobs`
      ) {
        latestDraftJobStatus = "QUEUED"
        return json(route, {
          jobId: "draft-job-e2e",
          draftId,
          status: "QUEUED",
          contactId,
          contactVersion: 1,
          evidenceSnapshotId: "evidence-snapshot-e2e",
          requestSnapshotId: "draft-request-snapshot-e2e",
          workflowId: "draft-workflow-e2e",
          generationMode: "MODEL",
          replayed: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/draft-jobs/latest`
      ) {
        return json(route, {
          job:
            latestDraftJobStatus === null
              ? null
              : draftJob(latestDraftJobStatus),
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/draft-jobs/draft-job-e2e`
      ) {
        const nextStatus =
          draftJobStatuses[
            Math.min(draftJobStatusReads, draftJobStatuses.length - 1)
          ] ?? "SUCCEEDED"
        draftJobStatusReads += 1
        latestDraftJobStatus = nextStatus
        return json(route, { job: draftJob(nextStatus), meta })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/drafts/${draftId}`
      ) {
        return json(route, {
          draft: {
            id: draftId,
            opportunityId,
            contactId,
            contactVersion: 1,
            status: draftApproved ? "approved" : "draft",
            draftVersion: 1,
            approvedVersionId: draftApproved ? draftVersionId : null,
            currentVersion: {
              id: draftVersionId,
              versionNo: 1,
              subjectText: "E2E collaboration proposal",
              bodyText: "A local-only E2E draft.",
              bodyDocument: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "A local-only E2E draft.",
                      },
                    ],
                  },
                ],
              },
              source: "MODEL",
              readiness: "AI_DRAFT_READY",
              fallbackReason: null,
              createdAt: now,
            },
          },
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/drafts/${draftId}/approve`
      ) {
        draftApproved = true
        return json(route, {
          draftId,
          versionId: draftVersionId,
          draftVersion: 1,
          status: "approved",
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/gmail-connections/status`
      ) {
        return json(route, {
          connection:
            selectedGmailConnectionId === gmailAccount.connectionId
              ? gmailAccount
              : null,
          accounts: [gmailAccount],
          readiness: gmailReadiness(),
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/gmail-connections/select`
      ) {
        const body = request.postDataJSON() as { connectionId?: string }
        selectedGmailConnectionId =
          body.connectionId === gmailAccount.connectionId
            ? gmailAccount.connectionId
            : null
        return json(route, {
          connection:
            selectedGmailConnectionId === gmailAccount.connectionId
              ? gmailAccount
              : null,
          accounts: [gmailAccount],
          readiness: gmailReadiness(),
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/gmail-connections/gmail-connection-e2e/sync-status`
      ) {
        return json(route, {
          state: "POLLING",
          workflowId: "gmail-polling-workflow-e2e",
          pollingIntervalSeconds: 60,
          killSwitchOpen: true,
          acceptedSendCount: 1,
          lastSuccessfulSyncAt: now,
          lastError: null,
          nextRetryAt: now,
          cursor: {
            historyId: "history-e2e",
            initialSyncCompletedAt: now,
            lastSyncedAt: now,
            version: 1,
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/contacts`
      ) {
        const firstContact = {
          id: contactId,
          opportunityId,
          prospectId,
          normalizedEmail: manualContactConfirmed
            ? "confirmed@publisher.example.test"
            : "editor@publisher.example.test",
          contactRole: "editorial",
          confirmedAt: now,
          status: "active",
          guessed: false,
          version: 1,
        }
        const items =
          contactMode === "none" && !manualContactConfirmed
            ? []
            : contactMode === "multiple" && !manualContactConfirmed
              ? [
                  firstContact,
                  {
                    ...firstContact,
                    id: "contact-e2e-secondary",
                    normalizedEmail: "partnerships@publisher.example.test",
                    contactRole: "partnerships",
                  },
                ]
              : [firstContact]
        return json(route, {
          items,
          selection: {
            state:
              items.length === 0
                ? "CONTACT_CONFIRMATION_REQUIRED"
                : items.length === 1
                  ? "AUTO_SELECTED"
                  : "USER_SELECTION_REQUIRED",
            autoSelectedContactId: items.length === 1 ? contactId : null,
          },
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/contacts/candidates`
      ) {
        manualCandidateCreated = true
        return json(
          route,
          {
            candidateId: "contact-candidate-manual-e2e",
            prospectId,
            recommendationContextVersionId: "context-e2e",
            normalizedEmail: "confirmed@publisher.example.test",
            contactRole: "editorial",
            status: "candidate",
            version: 1,
            lifecycleEventId: "lifecycle-manual-e2e",
            auditEventId: "audit-manual-e2e",
            replayed: false,
            meta,
          },
          201
        )
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/contacts/candidates/contact-candidate-manual-e2e/confirm`
      ) {
        manualContactConfirmed = manualCandidateCreated
        return json(route, {
          candidateId: "contact-candidate-manual-e2e",
          contactId,
          candidateStatus: "promoted",
          candidateVersion: 2,
          contactStatus: "active",
          contactVersion: 1,
          lifecycleEventId: "lifecycle-confirm-e2e",
          auditEventId: "audit-confirm-e2e",
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/contacts/candidates`
      ) {
        return json(route, {
          items: [
            {
              id: "contact-candidate-e2e",
              prospectId,
              recommendationContextVersionId: "context-e2e",
              normalizedEmail: "editor@publisher.example.test",
              domainRelation: "same_registrable_domain",
              confidence: 0.98,
              observedRole: "editor",
              inferredPurpose: "editorial",
              purposeConfidence: 0.95,
              purposeRuleVersion: "purpose-rule-e2e",
              purposeEvidence: [],
              guessed: false,
              status: "candidate",
              version: 1,
              evidence: [],
            },
          ],
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/drafts/${draftId}/send-preflight`
      ) {
        return json(route, {
          allowed: true,
          deliveryState: "NOT_SENT",
          checkedAt: now,
          readinessSnapshot: sendReadinessSnapshot,
          gmail: {
            connectionId: gmailAccount.connectionId,
            primaryEmail: gmailAccount.primaryEmail,
            connectionStatus: "CONNECTED",
            sendAvailability: "AVAILABLE",
            mailSyncCapability: true,
          },
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/drafts/${draftId}/send-intents`
      ) {
        return json(route, {
          sendIntentId,
          sendSnapshotId,
          draftId,
          approvedDraftVersionId: draftVersionId,
          contactId,
          contactVersion: 1,
          status: "READY",
          version: 1,
          requestedSendAt: now,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/send-intents`
      ) {
        return json(route, {
          items: [
            {
              sendIntentId: reconciliationSendIntentId,
              opportunityId,
              draftId,
              approvedDraftVersionId: draftVersionId,
              messagePurpose: "INITIAL_OUTREACH",
              followUpIndex: 0,
              status: "DELIVERY_UNKNOWN",
              queueKind: "RECONCILIATION_REQUIRED",
              version: 4,
              requestedSendAt: now,
              updatedAt: now,
              deliveryEnvelope: {
                sendSnapshotId: reconciliationSendSnapshotId,
                gmailConnectionId: gmailAccount.connectionId,
                gmailAccountEmail: gmailAccount.primaryEmail,
                gmailIdentityId: "gmail-identity-e2e",
                fromAddress: "outreach@example.test",
                recipient: "finance@publisher.example.test",
                contactId,
                contactVersion: 1,
                approvalRecordedAt: now,
              },
              diagnostics: {
                operationId: reconciliationSendIntentId,
                operationCheckpoint: "DELIVERY_UNKNOWN_PERSISTED",
                retryable: false,
                nextRetryAt: null,
                costUncertainty: "UNKNOWN",
                workerMode: "normal",
                buildIdentity: "local-product-e2e",
                primaryNextAction: "RECONCILE_BEFORE_RETRY",
              },
              attempt: {
                attemptId: reconciliationSendAttemptId,
                attemptNo: 1,
                status: "DELIVERY_UNKNOWN",
                rfcMessageId: "<growthos-reconciliation-e2e@example.test>",
                providerMessageId: null,
                providerThreadId: null,
                errorCode: "PROVIDER_RESULT_NOT_PERSISTED",
                startedAt: now,
                completedAt: now,
                retryEligibleAt: null,
              },
            },
          ],
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/send-intents/${reconciliationSendIntentId}`
      ) {
        return json(route, {
          sendIntent: {
            sendIntentId: reconciliationSendIntentId,
            opportunityId,
            draftId,
            approvedDraftVersionId: draftVersionId,
            messagePurpose: "INITIAL_OUTREACH",
            followUpIndex: 0,
            status: "DELIVERY_UNKNOWN",
            queueKind: "RECONCILIATION_REQUIRED",
            version: 4,
            requestedSendAt: now,
            updatedAt: now,
            deliveryEnvelope: {
              sendSnapshotId: reconciliationSendSnapshotId,
              gmailConnectionId: gmailAccount.connectionId,
              gmailAccountEmail: gmailAccount.primaryEmail,
              gmailIdentityId: "gmail-identity-e2e",
              fromAddress: "outreach@example.test",
              recipient: "finance@publisher.example.test",
              contactId,
              contactVersion: 1,
              approvalRecordedAt: now,
            },
            diagnostics: {
              operationId: reconciliationSendIntentId,
              operationCheckpoint: "DELIVERY_UNKNOWN_PERSISTED",
              retryable: false,
              nextRetryAt: null,
              costUncertainty: "UNKNOWN",
              workerMode: "normal",
              buildIdentity: "local-product-e2e",
              primaryNextAction: "RECONCILE_BEFORE_RETRY",
            },
            attempt: {
              attemptId: reconciliationSendAttemptId,
              attemptNo: 1,
              status: "DELIVERY_UNKNOWN",
              rfcMessageId: "<growthos-reconciliation-e2e@example.test>",
              providerMessageId: null,
              providerThreadId: null,
              errorCode: "PROVIDER_RESULT_NOT_PERSISTED",
              startedAt: now,
              completedAt: now,
              retryEligibleAt: null,
            },
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/send-intents/${sendIntentId}`
      ) {
        sendIntentStatusReads += 1
        const providerAccepted = sendIntentStatusReads >= 2
        return json(route, {
          sendIntent: {
            sendIntentId,
            opportunityId,
            draftId,
            approvedDraftVersionId: draftVersionId,
            messagePurpose: "INITIAL_OUTREACH",
            followUpIndex: 0,
            status: providerAccepted ? "PROVIDER_ACCEPTED" : "READY",
            queueKind: providerAccepted ? "WAITING_REPLY" : "PENDING_SEND",
            version: providerAccepted ? 3 : 1,
            requestedSendAt: now,
            updatedAt: now,
            deliveryEnvelope: {
              sendSnapshotId,
              gmailConnectionId: gmailAccount.connectionId,
              gmailAccountEmail: gmailAccount.primaryEmail,
              gmailIdentityId: "gmail-identity-e2e",
              fromAddress: "outreach@example.test",
              recipient: "finance@publisher.example.test",
              contactId,
              contactVersion: 1,
              approvalRecordedAt: now,
            },
            diagnostics: {
              operationId: sendIntentId,
              operationCheckpoint: providerAccepted
                ? "PROVIDER_ACCEPTANCE_PERSISTED"
                : "INTENT_PERSISTED",
              retryable: false,
              nextRetryAt: null,
              costUncertainty: "NONE",
              workerMode: "normal",
              buildIdentity: "local-product-e2e",
              primaryNextAction: providerAccepted
                ? "START_OR_CONTINUE_SYNC"
                : "WAIT_FOR_WORKER",
            },
            attempt: providerAccepted
              ? {
                  attemptId: sendAttemptId,
                  attemptNo: 1,
                  status: "PROVIDER_ACCEPTED",
                  rfcMessageId: "<growthos-e2e@example.test>",
                  providerMessageId: "gmail-message-e2e",
                  providerThreadId: "gmail-thread-e2e",
                  errorCode: null,
                  startedAt: now,
                  completedAt: now,
                  retryEligibleAt: null,
                }
              : null,
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/mail/messages`
      ) {
        return json(route, {
          items: [mailListItem],
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/mail/messages/${messageId}`
      ) {
        return json(route, { item: mailDetailItem, meta })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/mail/threads/${threadId}`
      ) {
        return json(route, {
          item: {
            id: threadId,
            latestMessageAt: now,
            messageCount: 1,
            version: 1,
            messages: [mailDetailItem],
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/replies/${inboundMessageId}/match-candidates`
      ) {
        return json(route, {
          inboundMessageId,
          matchStatus: "CANDIDATES_READY",
          items: [
            {
              id: replyCandidateId,
              inboundMessageId,
              opportunityId,
              candidateRank: 1,
              confidenceScore: 0.9,
              reasonCodes: [
                {
                  kind: "NORMALIZED_SUBJECT",
                  value: "e2e collaboration",
                },
              ],
              requiresManualConfirmation: true,
              createdAt: now,
            },
          ],
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/replies/${inboundMessageId}/match-candidates/${replyCandidateId}/confirm`
      ) {
        return json(route, {
          candidateId: replyCandidateId,
          inboundMessageId,
          opportunityId,
          matchStatus: "MATCH_CONFIRMED",
          auditEventId: "audit-event-e2e",
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/replies/${inboundMessageId}/negotiation-facts`
      ) {
        return json(route, {
          inboundMessageId,
          opportunityId,
          items: negotiationFacts,
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/replies/${inboundMessageId}/negotiation-facts/decisions`
      ) {
        const body = request.postDataJSON() as {
          sourceFactVersionId: string
          expectedFactVersion: number
          decision: "CONFIRM" | "REJECT" | "CORRECT"
          correction?: {
            factType: string
            rawValue: string
            normalizedValue: unknown
          }
        }
        const source = negotiationFacts.find(
          (fact) => fact.id === body.sourceFactVersionId
        )
        const latestFact = {
          ...(source ?? negotiationFact),
          id: "negotiation-fact-e2e-v2",
          factVersion: body.expectedFactVersion + 1,
          factType: body.correction?.factType ?? negotiationFact.factType,
          rawValue: body.correction?.rawValue ?? negotiationFact.rawValue,
          normalizedValue:
            body.correction?.normalizedValue ?? negotiationFact.normalizedValue,
          factAuthority: "MANUAL",
          reviewStatus: body.decision === "REJECT" ? "REJECTED" : "CONFIRMED",
          extractorType: "MANUAL",
          extractorVersion: "manual-review-e2e",
          decidedBy: "user-e2e",
          decidedAt: now,
          createdAt: now,
          createdBy: "user-e2e",
        }
        negotiationFacts = [...negotiationFacts, latestFact]
        return json(route, {
          decision: body.decision,
          replayed: false,
          appendedFactVersionIds: [latestFact.id],
          latestFact,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/profile`
      ) {
        return json(route, {
          canonicalDomain: "owner.example.test",
          snapshot: {
            snapshotId: "profile-snapshot-e2e",
            provider: "dataforseo",
            observedAt: now,
            freshUntil: "2026-07-31T00:00:00.000Z",
            freshness: "stale",
            completeness: "partial",
            totalBacklinks: 84,
            referringDomains: 38,
            dofollow: 61,
            nofollow: 23,
            sponsored: null,
            ugc: null,
            newBacklinks: 7,
            lostBacklinks: 6,
            inventoryPulledCount: 42,
            inventoryCoverage: 0.5,
            distributions: {
              anchors: {
                "owner guide": 14,
                "brand mention": 12,
                "read more": 8,
              },
              countries: { US: 22, GB: 20 },
              sourceDomains: {
                "publisher.example.test": 18,
                "news.example.test": 13,
                "blog.example.test": 11,
              },
            },
            unavailableMetrics: ["sponsored", "ugc"],
            costMicros: 55_200,
            nextSyncAt: "2026-08-07T00:00:00.000Z",
          },
          health: {
            score: 74,
            grade: "B",
            components: [
              ["Coverage", 50],
              ["Domain diversity", 78],
              ["Follow mix", 82],
              ["Spam risk", 88],
              ["Anchor mix", 72],
              ["Link velocity", 64],
              ["Country relevance", 79],
              ["Target distribution", 70],
              ["Placement validation", 55],
            ].map(([label, score], index) => ({
              id: `health-${index + 1}`,
              label,
              score,
            })),
            risks: ["Inventory coverage is partial"],
            positives: ["Referring domains are diversified"],
            evidenceObservedAt: now,
            modelVersion: "backlink-profile-health.v1",
          },
          sync: {
            providerEnabled: false,
            status: "waiting_provider",
            lastSyncAt: now,
            nextSyncAt: "2026-08-07T00:00:00.000Z",
            estimatedCostMicros: 55_200,
            actualCostMicros: 55_200,
            stale: true,
            partial: true,
            providerInputRequired: true,
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/inventory`
      ) {
        const pageNumber = Number(url.searchParams.get("page") ?? "1")
        const pageSize = Number(url.searchParams.get("pageSize") ?? "20")
        const status = url.searchParams.get("status")
        const source = url.searchParams.get("source")
        const query = url.searchParams.get("query")?.toLowerCase() ?? ""
        const sort = url.searchParams.get("sort") ?? "last_seen_desc"
        const filtered = profileInventory
          .filter((item) => status === null || item.providerStatus === status)
          .filter((item) => source === null || item.sourceType === source)
          .filter(
            (item) =>
              query.length === 0 ||
              item.sourceDomain.toLowerCase().includes(query) ||
              item.sourceUrl.toLowerCase().includes(query) ||
              item.anchorText.toLowerCase().includes(query)
          )
          .sort((left, right) =>
            sort === "rank_desc"
              ? right.rank - left.rank
              : sort === "spam_desc"
                ? right.spamScore - left.spamScore
                : 0
          )
        const offset = (pageNumber - 1) * pageSize
        return json(route, {
          items: filtered.slice(offset, offset + pageSize),
          page: pageNumber,
          pageSize,
          totalCount: filtered.length,
          totalPages: Math.ceil(filtered.length / pageSize),
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/inventory-items`
      ) {
        const body = request.postDataJSON() as {
          sourceUrl: string
          targetUrl: string
        }
        return json(route, {
          inventoryItemId: "inventory-imported-e2e",
          sourceUrl: body.sourceUrl,
          targetUrl: body.targetUrl,
          tier: "A",
          monitoringStatus: "enabled",
          nextCheckAt: "2026-08-06T12:00:00.000Z",
          replayed: false,
          meta,
        })
      }

      if (
        method === "PATCH" &&
        pathname.startsWith(
          `/api/v1/projects/${projectKey}/backlinks/inventory-items/`
        ) &&
        pathname.endsWith("/monitoring-policy")
      ) {
        const body = request.postDataJSON() as {
          important: boolean
          monitoringStatus: "enabled" | "paused"
        }
        const inventoryItemId = pathname.split("/").at(-2)
        return json(route, {
          inventoryItemId,
          tier: body.important ? "A" : "B",
          importance: body.important ? "important" : "normal",
          monitoringStatus: body.monitoringStatus,
          policyVersion: "inventory-monitoring-v1",
          policyRevision: 2,
          nextCheckAt:
            body.monitoringStatus === "enabled"
              ? "2026-08-06T12:00:00.000Z"
              : null,
          providerOnlyReason: null,
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname.startsWith(
          `/api/v1/projects/${projectKey}/backlinks/inventory-items/`
        ) &&
        pathname.endsWith("/checks")
      ) {
        const inventoryItemId = pathname.split("/").at(-2)
        return json(route, {
          inventoryItemId,
          runId: "inventory-monitor-run-e2e",
          observationId: "inventory-observation-e2e-1",
          workflowId: "inventory-monitor-workflow-e2e",
          scheduledFor: now,
          replayed: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname.startsWith(
          `/api/v1/projects/${projectKey}/backlinks/inventory-items/`
        ) &&
        pathname.endsWith("/direct-observations")
      ) {
        return json(route, {
          items: [
            {
              observationId: "inventory-observation-e2e-1",
              runId: "inventory-monitor-run-e2e",
              result: "present",
              directValidationStatus: "VALID",
              failureCode: null,
              restrictionReason: null,
              evidenceSnapshot: {
                httpStatus: 200,
                finalUrl: "https://source-1.publisher.example.test/article",
                targetUrl: "https://owner.example.test/guide",
                anchorText: "anchor 1",
                relAttributes: ["dofollow"],
                metaRobotsNoindex: false,
                xRobotsTagNoindex: false,
                canonicalUrl: "https://source-1.publisher.example.test/article",
                redirectChain: [],
              },
              observedAt: now,
            },
          ],
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/profile-sync-jobs`
      ) {
        return json(route, {
          jobId: "profile-sync-job-e2e",
          workflowId: "profile-sync-workflow-e2e",
          status: "waiting_provider",
          canonicalDomain: "owner.example.test",
          estimatedCostMicros: 55_200,
          providerInputRequired: true,
          replayed: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/profile-sync-jobs/profile-sync-job-e2e`
      ) {
        return json(route, {
          job: {
            jobId: "profile-sync-job-e2e",
            status: "waiting_provider",
            canonicalDomain: "owner.example.test",
            totalCount: 84,
            pulledCount: 42,
            inventoryCoverage: 0.5,
            estimatedCostMicros: 55_200,
            actualCostMicros: 0,
            nextSyncAt: "2026-08-07T00:00:00.000Z",
            errorCode: "provider_input_required",
            startedAt: null,
            finishedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/settings`
      ) {
        return json(route, {
          settings: {
            id: "settings-e2e",
            version: 1,
            values: {
              reportingTimezone: "Africa/Johannesburg",
              reportLookbackDays: 30,
              exportExpiryHours: 24,
              discoveryTargetAudiences: ["South African streaming viewers"],
              discoveryPartnershipGoals: ["Editorial review"],
              discoveryExplicitCompetitorDomains: [],
            },
          },
          killSwitches: [],
          editableKillSwitchLayers: ["project", "provider"],
          retention: {
            id: "retention-e2e",
            version: 1,
            rules: [],
            exceptions: ["audit_record", "lifecycle_record"],
          },
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/metrics/dashboard`
      ) {
        const asOf = url.searchParams.get("asOf") ?? now
        const from = url.searchParams.get("from") ?? now
        const to = url.searchParams.get("to") ?? now
        return json(route, {
          dashboard: {
            timezone: url.searchParams.get("timezone") ?? "Africa/Johannesburg",
            from,
            to,
            asOf,
            summary: [
              {
                snapshotId: "metric-snapshot-e2e",
                snapshotVersion: 1,
                windowStart: from,
                windowEnd: to,
                asOf,
                dimensions: { projectId: projectKey },
                numerator: 1,
                denominator: null,
                value: 1,
                metricKey: "active_placement_count",
                metricDefinitionVersion: "placement-health-v1",
              },
            ],
            trends: [],
          },
          meta: {
            ...meta,
            schemaVersion: "backlink-metric-dashboard.v1",
          },
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/reports`
      ) {
        return json(route, {
          reports: [
            {
              id: "report-revision-e2e",
              reportKey: "placement-health",
              revision: 1,
              inputSnapshotIds: ["metric-snapshot-e2e"],
              metricDefinitionVersions: {
                active_placement_count: "placement-health-v1",
              },
              querySpec: { websiteProjectId: projectKey },
              payload: { activePlacementCount: 1 },
              sourceStartedAt: now,
              sourceEndedAt: now,
              sourceWatermarkAt: now,
              sourceWatermarkId: "placement-event-e2e",
              resultChecksum: "sha256:report-e2e",
              generatedAt: now,
              freshness: "fresh",
            },
          ],
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/performance/backlinks`
      ) {
        const latestFailure =
          performanceBacklinksMode === "provider_failed"
            ? { status: "failed", code: "provider_timeout" }
            : { status: "none", code: null }
        const item = {
          ...placementListItem,
          freshness:
            performanceBacklinksMode === "provider_failed" ? "stale" : "fresh",
          latestFailure,
        }
        return json(route, {
          items: [item],
          nextCursor: null,
          hasMore: false,
          summary: {
            placements: {
              total: 1,
              pendingVerification: 0,
              active: 1,
              suspectedChanged: 0,
              changed: 0,
              suspectedLost: 0,
              lost: 0,
              recovered: 0,
            },
            candidates: {
              total: 2,
              countsTowardKpi: false,
            },
            evidence: {
              source: "DIRECT_MONITOR",
              dataCutoff: now,
              freshness:
                performanceBacklinksMode === "provider_failed"
                  ? "stale"
                  : "fresh",
              lastSuccessfulObservationAt: now,
              latestAttemptAt: "2026-08-22T00:00:00.000Z",
              latestAttemptStatus:
                performanceBacklinksMode === "provider_failed"
                  ? "failed"
                  : "completed",
              latestFailure,
            },
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname === `/api/v1/projects/${projectKey}/backlinks/links`
      ) {
        return json(route, {
          items:
            url.searchParams.get("view") === "confirmed"
              ? [placementListItem]
              : [],
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/links/placements/${placementId}`
      ) {
        return json(route, {
          link: {
            ...placementListItem,
            opportunityId,
            normalizedSourceUrl: "https://publisher.example.test/article",
            normalizedTargetUrl: "https://owner.example.test/guide",
            urlNormalizationVersion: "url-normalization-e2e",
            updatedAt: now,
            initialValidation: {
              validationRunId: "validation-run-e2e",
              status: "VERIFIED",
              evidenceSource: "DIRECT_VALIDATION",
              evidenceSnapshotHash: "sha256:initial-e2e",
              evidenceContractVersion: "placement.validation-evidence.v1",
              evidenceSchemaVersion: 1,
            },
            nextCheckAt: now,
            consecutiveAnomalies: 0,
            browserFallbackEnabled: true,
            latestObservation: {
              observationId: "observation-e2e",
              result: "present",
              observedAt: now,
              executionMode: "static",
              evidenceSource: "DIRECT_MONITOR",
              evidence: {
                evidenceId: "evidence-e2e",
                hash: "sha256:observation-e2e",
                contractVersion: "placement.observation-evidence.v1",
                schemaVersion: 1,
                freshness: "fresh",
              },
              failure: {
                status: "none",
                code: null,
              },
            },
            lastSuccessfulObservation: {
              observationId: "observation-e2e",
              result: "present",
              observedAt: now,
              executionMode: "static",
              evidenceSource: "DIRECT_MONITOR",
              evidence: {
                evidenceId: "evidence-e2e",
                hash: "sha256:observation-e2e",
                contractVersion: "placement.observation-evidence.v1",
                schemaVersion: 1,
                freshness: "stale",
              },
              failure: {
                status: "none",
                code: null,
              },
            },
            latestMonitorRun: {
              monitorRunId: "monitor-run-e2e",
              status:
                performanceBacklinksMode === "provider_failed"
                  ? "failed"
                  : "completed",
              scheduledFor: now,
              updatedAt: "2026-08-22T00:00:00.000Z",
            },
          },
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/links/placements/${placementId}/events`
      ) {
        return json(route, {
          items: [
            {
              eventId: "placement-event-e2e",
              eventType: "placement.confirmed",
              occurredAt: now,
              placementVersion: 3,
              previousHealthStatus: null,
              nextHealthStatus: "HEALTHY",
              observationId: "observation-e2e",
              reason: "Static verification confirmed placement.",
            },
          ],
          nextCursor: null,
          hasMore: false,
          meta,
        })
      }

      if (
        method === "GET" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/links/evidence/evidence-e2e`
      ) {
        return json(route, {
          evidence: {
            evidenceId: "evidence-e2e",
            placementId,
            kind: "placement_observation",
            evidenceSource: "DIRECT_MONITOR",
            immutable: true,
            hashVerified: true,
            hash: "sha256:observation-e2e",
            contractVersion: "placement.observation-evidence.v1",
            schemaVersion: 1,
            observedAt: now,
            executionMode: "static",
            result: "present",
            reasonCode: null,
            failure: {
              status: "none",
              code: null,
            },
            freshness: "stale",
            source: {
              sourcePageUrl: "https://publisher.example.test/article",
              targetUrl: "https://owner.example.test/guide",
              fetchMode: "static",
              httpStatus: 200,
              finalUrl: "https://publisher.example.test/article",
              contentType: "text/html",
              fetchedAt: now,
              redirectChain: [],
              xRobotsTag: null,
            },
            link: {
              canonicalUrl: "https://publisher.example.test/article",
              noindex: false,
              occurrenceCount: 1,
              robotsDirectives: [],
              occurrences: [
                {
                  resolvedHref: "https://owner.example.test/guide",
                  anchorText: "Owner guide",
                  rel: [],
                  nofollow: false,
                  sponsored: false,
                  ugc: false,
                },
              ],
            },
          },
          meta,
        })
      }

      if (
        method === "POST" &&
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/links/placements/${placementId}/reverify`
      ) {
        return json(route, {
          placementId,
          placementVersion: placementListItem.version,
          accepted: true,
          replayed: false,
          browserFallbackAllowed: false,
          monitorRun: {
            monitorRunId: "monitor-run-reverify-e2e",
            status: "scheduled",
            scheduledFor: "2026-08-22T00:05:00.000Z",
          },
          meta,
        })
      }

      unexpectedNetwork.push(`${method} ${request.url()}`)
      return json(route, { detail: "Unexpected E2E API request" }, 501)
    }

    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      (url.protocol === "http:" || url.protocol === "https:")
    ) {
      return route.continue()
    }

    if (url.protocol === "data:" || url.protocol === "blob:") {
      return route.continue()
    }

    unexpectedNetwork.push(`${method} ${request.url()}`)
    return route.abort("blockedbyclient")
  })

  return { capturedRequests, unexpectedNetwork }
}
