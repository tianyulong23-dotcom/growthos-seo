import type { Page, Route } from "@playwright/test"

export const outreachFixture = {
  projectKey: "e2e-project",
  recommendationId: "recommendation-e2e",
  opportunityId: "opportunity-e2e",
  prospectId: "prospect-e2e",
  contactId: "contact-e2e",
  draftId: "draft-e2e",
  draftVersionId: "draft-version-e2e",
  sendIntentId: "send-intent-e2e",
  sendSnapshotId: "send-snapshot-e2e",
  sendAttemptId: "send-attempt-e2e",
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
  sendSnapshotId,
  sendAttemptId,
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

const opportunityListItem = {
  id: opportunityId,
  targetSiteKey: "publisher.example.test",
  targetHostAscii: "publisher.example.test",
  joinSequence: 1,
  businessStage: "READY_TO_CONTACT",
  managementStatus: "ACTIVE",
  outcomeStatus: "OPEN",
  fulfillmentStatus: "NOT_EXPECTED",
  sourceContactCandidateId: "contact-candidate-e2e",
  contactEmail: "editor@publisher.example.test",
  contactReviewRequired: false,
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
  sourcePageUrl: "https://publisher.example.test/article",
  targetUrl: "https://owner.example.test/guide",
  initialValidationStatus: "VERIFIED",
  healthStatus: "HEALTHY",
  monitoringStatus: "ACTIVE",
  version: 3,
  createdAt: now,
  countsTowardKpi: true,
}

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
  let manualCandidateCreated = false
  let manualContactConfirmed = false
  let opportunityManagementStatus: "ACTIVE" | "PAUSED" | "ARCHIVED" = "ACTIVE"
  let opportunityVersion = opportunityListItem.version
  let selectedGmailConnectionId =
    gmailMode === "selected" ? "gmail-connection-e2e" : null
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
    recentErrorCategory: null,
  }
  const currentOpportunityListItem = () => ({
    ...opportunityListItem,
    managementStatus: opportunityManagementStatus,
    version: opportunityVersion,
    updatedAt: new Date().toISOString(),
  })
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

      if (method === "GET" && pathname === "/api/v1/projects") {
        return json(route, [
          {
            id: "website-project-e2e",
            website_project_key: projectKey,
            name: "E2E Project",
            domain: "owner.example.test",
            country: "US",
            language: "en",
            health: 100,
            status: "ACTIVE",
            archived_at: null,
            target_market: "United States",
            context_version: 1,
            profile_version_id: "profile-e2e",
            promotion_target_version_id: "promotion-target-e2e",
            keywords: ["publisher outreach"],
            products: ["E2E product"],
            target_urls: ["https://owner.example.test/guide"],
            input_required: [],
            created_at: "2026-08-05T00:00:00.000Z",
            updated_at: "2026-08-05T00:00:00.000Z",
          },
        ])
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
          items: [
            {
              id: recommendationId,
              hostname: "publisher.example.test",
              score: 92,
              status: "ready",
              recommendationContextVersionId: "context-e2e",
              version: 1,
              scoreModelVersion: assessment.scoreModelVersion,
              ruleVersion: assessment.ruleVersion,
              assessment,
              rootUrl: "https://publisher.example.test/",
              faviconUrl: "https://publisher.example.test/favicon.ico",
              acquiredAt: now,
              matchReasons: ["Editorial fit"],
              dataSources: ["local-e2e"],
              seoMetrics: {
                authority: 92,
                editorialQuality: 92,
                technicalHealth: 92,
              },
              contactStatus: "contactable",
              contactJob: null,
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
          `/api/v1/projects/${projectKey}/backlinks/recommendation-inventory`
      ) {
        return json(route, {
          candidateReadyCount: 1,
          publishedContactReadyCount: 1,
          historicalEmailHitRate: 1,
          candidateLowWatermark: 20,
          candidateHighWatermark: 40,
          publishedLowWatermark: 5,
          publishedHighWatermark: 10,
          blueprintVersion: "e2e-blueprint-v1",
          blueprintGenerator: "local-e2e",
          latestRefillAt: now,
          nextRefillAt: null,
          providerCollectedAt: now,
          pauseReason: null,
          refillInFlight: false,
          contactBatch: {
            id: "contact-batch-e2e",
            status: "completed",
            totalJobCount: 1,
            terminalJobCount: 1,
            publishedCount: 1,
            unpublishedCount: 0,
            retryableUnpublishedCount: 0,
            reasonCounts: [{ reasonCode: "PUBLIC_EMAIL_FOUND", count: 1 }],
            startedAt: now,
            completedAt: now,
          },
          meta,
        })
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
        pathname ===
          `/api/v1/projects/${projectKey}/backlinks/send-intents/${sendIntentId}`
      ) {
        sendIntentStatusReads += 1
        const providerAccepted = sendIntentStatusReads >= 2
        return json(route, {
          sendIntent: {
            sendIntentId,
            draftId,
            status: providerAccepted ? "PROVIDER_ACCEPTED" : "READY",
            version: providerAccepted ? 3 : 1,
            requestedSendAt: now,
            updatedAt: now,
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
            latestMonitorRun: {
              monitorRunId: "monitor-run-e2e",
              status: "completed",
              scheduledFor: now,
              updatedAt: now,
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
