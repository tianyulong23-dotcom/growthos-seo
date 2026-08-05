import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createPlacementLinksQuery } from "../../../src/modules/backlinks/application/queries/placement-links.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  createBacklinksPrivateApi,
  startBacklinksPrivateApi,
  type StartedBacklinksPrivateApi,
} from "../../../src/modules/backlinks/api/private-server.js";
import { gmailOAuthScopes } from "../../../src/modules/backlinks/domain/sending/oauth-attempt.js";

const signingKey = "test-only-platform-context-key-32-bytes";
const startedServers: StartedBacklinksPrivateApi[] = [];
const gmailConnection = {
  connectionId: "018f0000-0000-7000-8000-000000000020",
  version: 1,
  primaryEmail: "owner@example.com",
  displayName: "Example Owner",
  hostedDomain: "example.com",
  grantedScopes: gmailOAuthScopes,
  connectionStatus: "CONNECTED" as const,
  sendAvailability: "AVAILABLE" as const,
  mailSyncCapability: true,
  tokenExpiresAt: "2026-07-27T06:00:00.000Z",
  connectedAt: "2026-07-27T05:00:00.000Z",
};

function createDependencies() {
  const actor = createActorContext({
    userId: "user-private-api",
    sessionId: "session-private-api",
    roles: ["member"],
  });
  const context = {
    actor,
    tenant: createTenantContext({
      organizationId: "org-private-api",
      workspaceId: "workspace-private-api",
    }),
    project: createProjectContext({
      websiteProjectId: "project-private-api",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-private-api",
      promotionTargetVersionId: "target-private-api",
    }),
  };

  return {
    module: createBacklinksModule({
      projectContext: { resolve: async () => context },
      queries: {
        listOpportunities: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        getOpportunity: async () => ({
          id: "018f0000-0000-7000-8000-000000000004",
          recommendationId: "018f0000-0000-7000-8000-000000000003",
          prospectId: "018f0000-0000-7000-8000-000000000002",
          recommendationContextVersionId:
            "018f0000-0000-7000-8000-000000000001",
          targetSiteKey: "example.com",
          targetHostAscii: "www.example.com",
          targetIdentityKind: "registrable_domain" as const,
          targetIdentityRuleVersion: "tldts-v1",
          targetIdentityOverrideReason: null,
          sourceContactCandidateId:
            "018f0000-0000-7000-8000-000000000006",
          contactEmail: "editorial@publisher.test",
          contactReviewRequired: false,
          hasDownstreamFacts: false,
          joinSequence: 1,
          businessStage: "JOINED" as const,
          managementStatus: "ACTIVE" as const,
          outcomeStatus: "OPEN" as const,
          fulfillmentStatus: "NOT_EXPECTED" as const,
          version: 1,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        }),
        listRecommendations: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        getSummary: async () => ({}),
        getAssessment: async () => ({
          run: {
            id: "7c935e5c-f915-4fe4-b47b-98cc283611b7",
            opportunityId: "27b4bf0e-b48a-4ec5-a66b-f8956ff87fb6",
            status: "SUCCEEDED",
            attemptCount: 1,
            sourceReleaseIds: ["release-2026-07-27"],
            startedAt: "2026-07-27T00:00:00.000Z",
            finishedAt: "2026-07-27T00:01:00.000Z",
            errorCode: null,
          },
          result: {
            snapshotId: "a8646413-5769-4ee0-850a-87a977a38b39",
            snapshotVersion: 1,
            isCurrent: true,
            availability: "available",
            stale: false,
            sourceReleaseIds: ["release-2026-07-27"],
            generatedAt: "2026-07-27T00:01:00.000Z",
            payload: {},
          },
        }),
        getJob: async () => ({
          id: "018f0000-0000-7000-8000-000000000010",
          draftId: "018f0000-0000-7000-8000-000000000011",
          status: "QUEUED" as const,
          contactId: "018f0000-0000-7000-8000-000000000013",
          contactVersion: 1,
          versionId: null,
          lastSuccessfulVersionId: null,
        }),
        getDraft: async () => ({
          id: "018f0000-0000-7000-8000-000000000011",
          opportunityId: "018f0000-0000-7000-8000-000000000004",
          contactId: "018f0000-0000-7000-8000-000000000013",
          contactVersion: 1,
          status: "draft" as const,
          draftVersion: 1,
          approvedVersionId: null,
          currentVersion: {
            id: "018f0000-0000-7000-8000-000000000012",
            versionNo: 1,
            subjectText: "Draft subject",
            bodyText: "Draft body",
            bodyDocument: {
              type: "doc" as const,
              content: [{
                type: "paragraph" as const,
                content: [{ type: "text" as const, text: "Draft body" }],
              }],
            },
            source: "MODEL" as const,
            createdAt: "2026-07-27T05:00:00.000Z",
          },
        }),
        getSendIntent: async () => ({
          sendIntentId: "018f0000-0000-7000-8000-000000000014",
          draftId: "018f0000-0000-7000-8000-000000000011",
          status: "READY" as const,
          version: 1,
          requestedSendAt: "2026-07-27T05:00:00.000Z",
          updatedAt: "2026-07-27T05:00:00.000Z",
          attempt: null,
        }),
        listMailMessages: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        getMailMessage: async () => ({
          id: "018f0000-0000-7000-8000-000000000139",
          threadId: "018f0000-0000-7000-8000-000000000239",
          direction: "INBOUND" as const,
          fromAddress: null,
          toAddresses: [],
          ccAddresses: [],
          subject: null,
          receivedAt: "2026-07-29T01:39:00.000Z",
          parseStatus: "PENDING" as const,
          version: 1,
          inboundMessageId: null,
          matchStatus: null,
          matchedOpportunityId: null,
          body: {
            plainText: null,
            sanitizedHtml: null,
          },
        }),
        getMailThread: async () => ({
          id: "018f0000-0000-7000-8000-000000000239",
          latestMessageAt: null,
          messageCount: 0,
          version: 1,
          messages: [],
        }),
        ...createPlacementLinksQuery({
          query: async () => ({ rows: [] }),
        }),
      },
    }),
    contactCommands: {
      listCandidates: async () => [],
      listOpportunityContacts: async () => ({
        items: [],
        state: "CONTACT_CONFIRMATION_REQUIRED" as const,
        autoSelectedContactId: null,
      }),
      confirm: async () => ({
        candidateId: "018f0000-0000-7000-8000-000000000001",
        contactId: "018f0000-0000-7000-8000-000000000002",
        candidateStatus: "promoted" as const,
        candidateVersion: 2,
        contactStatus: "active" as const,
        contactVersion: 1,
        lifecycleEventId: "lifecycle-private-api",
        auditEventId: "audit-private-api",
      }),
    },
    opportunityCommands: {
      createFromRecommendation: async () => ({
        opportunityId: "018f0000-0000-7000-8000-000000000004",
        recommendationId: "018f0000-0000-7000-8000-000000000003",
        websiteProjectId: "018f0000-0000-7000-8000-000000000000",
        targetSiteKey: "publisher.test",
        targetHostAscii: "publisher.test",
        cycleId: "018f0000-0000-7000-8000-000000000005",
        contactCandidateId: "018f0000-0000-7000-8000-000000000006",
        contactReviewRequired: false,
        joinSequence: 1, businessStage: "JOINED" as const,
        managementStatus: "ACTIVE" as const, outcomeStatus: "OPEN" as const,
        fulfillmentStatus: "NOT_EXPECTED" as const, version: 1,
        lifecycleEventId: "lifecycle-create-private-api",
        auditEventId: "audit-create-private-api", replayed: false,
      }),
      transitionBusinessStage: async () => ({
        opportunityId: "018f0000-0000-7000-8000-000000000004",
        businessStage: "CONTACT_PREPARING",
        managementStatus: "ACTIVE", outcomeStatus: "OPEN",
        fulfillmentStatus: "NOT_EXPECTED", version: 2,
        lifecycleEventId: "lifecycle-transition-private-api",
        auditEventId: "audit-transition-private-api", replayed: false,
      }),
      patchManagement: async () => ({
        opportunityId: "018f0000-0000-7000-8000-000000000004",
        businessStage: "CONTACT_PREPARING", managementStatus: "PAUSED",
        outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED", version: 3,
        lifecycleEventId: "lifecycle-management-private-api",
        auditEventId: "audit-management-private-api", replayed: false,
      }),
    },
    placementCandidateCommand: {
      execute: async () => ({
        candidateId: "018f0000-0000-7000-8000-000000000147",
        status: "PENDING_MATCH" as const,
        matchStatus: "UNMATCHED" as const,
        initialValidationStatus: "PENDING" as const,
        version: 1,
        countsTowardKpi: false as const,
        replayed: false,
      }),
    },
    placementReverifyCommand: {
      execute: async () => ({
        placementId: "018f0000-0000-7000-8000-000000000151",
        placementVersion: 2,
        accepted: true,
        replayed: false,
        browserFallbackAllowed: false,
        monitorRun: {
          monitorRunId: "018f0000-0000-7000-8000-000000000154",
          status: "scheduled",
          scheduledFor: "2026-07-29T00:00:00.000Z",
        },
      }),
    },
    placementReviewCommand: {
      confirm: async () => ({
        action: "manual_confirm" as const,
        candidateId: "018f0000-0000-7000-8000-000000000149",
        candidateStatus: "PROMOTED" as const,
        initialValidationStatus: "MANUALLY_CONFIRMED" as const,
        candidateVersion: 2,
        validationRunId: "018f0000-0000-7000-8000-000000000150",
        placementId: "018f0000-0000-7000-8000-000000000151",
        placementVersion: 1,
        monitoringOutboxEventId: "018f0000-0000-7000-8000-000000000152",
        lifecycleEventId: "018f0000-0000-7000-8000-000000000153",
        auditEventId: "018f0000-0000-7000-8000-000000000154",
        countsTowardKpi: true as const,
      }),
      reject: async () => ({
        action: "reject" as const,
        candidateId: "018f0000-0000-7000-8000-000000000149",
        candidateStatus: "REJECTED" as const,
        initialValidationStatus: "INVALID" as const,
        candidateVersion: 2,
        lifecycleEventId: "018f0000-0000-7000-8000-000000000153",
        auditEventId: "018f0000-0000-7000-8000-000000000154",
        countsTowardKpi: false as const,
      }),
    },
    recommendationCommands: {
      reject: async () => ({
        recommendationId: "018f0000-0000-7000-8000-000000000003",
        status: "rejected" as const,
        version: 2,
        lifecycleEventId: "lifecycle-reject-private-api",
        auditEventId: "audit-reject-private-api",
        replayed: false,
      }),
      requestRefill: async () => ({
        jobId: "job-private-api",
        workflowId: "workflow-private-api",
        status: "queued" as const,
        version: 1,
        lifecycleEventId: "lifecycle-refill-private-api",
        auditEventId: "audit-refill-private-api",
        replayed: false,
      }),
    },
    metricDashboardQuery: {
      getDashboard: async () => ({
        timezone: "UTC",
        from: new Date("2026-07-28T00:00:00.000Z"),
        to: new Date("2026-07-29T00:00:00.000Z"),
        asOf: new Date("2026-07-29T01:00:00.000Z"),
        summary: [],
        trends: [],
      }),
    },
    reportOverviewQuery: {
      listPublished: async () => [],
    },
    reportExportWorkflow: {
      request: async () => ({
        id: "018f0000-0000-7000-8000-000000000169",
        organizationId: "org-private-api",
        workspaceId: "workspace-private-api",
        websiteProjectId: "project-private-api",
        reportKey: "weekly-performance",
        reportRevisionId: "018f0000-0000-7000-8000-000000000165",
        format: "csv" as const,
        status: "queued" as const,
        requestedBy: "user-private-api",
        correlationId: "request-private-api",
        objectReference: null,
        createdAt: new Date("2026-07-29T01:00:00.000Z"),
        completedAt: null,
        expiresAt: null,
        failureCode: null,
      }),
      run: async () => {
        throw new Error("Private API bootstrap must not render exports.");
      },
      get: async () => ({
        id: "018f0000-0000-7000-8000-000000000169",
        organizationId: "org-private-api",
        workspaceId: "workspace-private-api",
        websiteProjectId: "project-private-api",
        reportKey: "weekly-performance",
        reportRevisionId: "018f0000-0000-7000-8000-000000000165",
        format: "csv" as const,
        status: "completed" as const,
        requestedBy: "user-private-api",
        correlationId: "request-private-api",
        objectReference: null,
        createdAt: new Date("2026-07-29T01:00:00.000Z"),
        completedAt: new Date("2026-07-29T01:01:00.000Z"),
        expiresAt: new Date("2026-07-30T01:01:00.000Z"),
        failureCode: null,
      }),
      authorizeDownload: async () => ({
        url: "https://objects.example.test/signed/export.csv",
        expiresAt: new Date("2026-07-29T01:10:00.000Z"),
      }),
    },
    settingsGovernanceService: {
      getView: async () => ({
        settings: {
          id: "settings-private-api",
          version: 1,
          values: {
            reportingTimezone: "UTC",
            reportLookbackDays: 30,
            exportExpiryHours: 24,
          },
        },
        killSwitches: [],
        editableKillSwitchLayers: ["project" as const, "provider" as const],
        retention: {
          id: "retention-private-api",
          version: 1,
          rules: [],
          exceptions: [],
        },
      }),
      updateSettings: async () => ({
        id: "settings-private-api",
        version: 2,
        values: {
          reportingTimezone: "UTC",
          reportLookbackDays: 30,
          exportExpiryHours: 24,
        },
      }),
      updateKillSwitch: async () => ({
        capability: "DATA_PROVIDER",
        provider: "DataForSEO",
        effectiveBlocked: true,
        sourceLayer: "project" as const,
        sourceScopeId: "project-private-api",
        sourceVersion: 1,
        editable: true,
      }),
    },
    replyMatchCommands: {
      listCandidates: async () => ({
        state: "found" as const,
        inboundMessageId: "018f0000-0000-7000-8000-000000000135",
        matchStatus: "UNMATCHED" as const,
        candidates: [],
      }),
      confirm: async () => ({
        state: "confirmed" as const,
        candidateId: "018f0000-0000-7000-8000-000000000235",
        inboundMessageId: "018f0000-0000-7000-8000-000000000135",
        opportunityId: "018f0000-0000-7000-8000-000000000335",
        matchStatus: "MATCH_CONFIRMED" as const,
        auditEventId: "018f0000-0000-7000-8000-000000000435",
      }),
    },
    draftCommands: {
      create: async () => ({
        jobId: "018f0000-0000-7000-8000-000000000010",
        draftId: "018f0000-0000-7000-8000-000000000011",
        status: "QUEUED" as const,
        contactId: "018f0000-0000-7000-8000-000000000013",
        contactVersion: 1,
        replayed: false,
      }),
    },
    draftEditingCommands: {
      saveManualVersion: async () => ({
        draftId: "018f0000-0000-7000-8000-000000000011",
        versionId: "018f0000-0000-7000-8000-000000000012",
        draftVersion: 2,
        status: "draft" as const,
      }),
      approve: async () => ({
        draftId: "018f0000-0000-7000-8000-000000000011",
        versionId: "018f0000-0000-7000-8000-000000000012",
        draftVersion: 3,
        status: "approved" as const,
      }),
    },
    sendIntentCommands: {
      create: async () => ({
        sendIntentId: "018f0000-0000-7000-8000-000000000114",
        sendSnapshotId: "018f0000-0000-7000-8000-000000000115",
        draftId: "018f0000-0000-7000-8000-000000000011",
        approvedDraftVersionId:
          "018f0000-0000-7000-8000-000000000012",
        contactId: "018f0000-0000-7000-8000-000000000013",
        contactVersion: 1,
        status: "READY" as const,
        version: 1 as const,
        requestedSendAt: "2026-07-27T10:14:00.000Z",
      }),
    },
    gmailConnectionCommands: {
      connect: async () => ({
        authorizationUrl: "https://accounts.example.test/authorize",
        expiresAt: "2026-07-27T05:10:00.000Z",
      }),
      complete: async () => ({
        connection: gmailConnection,
        returnPath: null,
      }),
      disconnect: async () => ({
        connection: {
          ...gmailConnection,
          version: 2,
          connectionStatus: "DISCONNECTED" as const,
          sendAvailability: "PAUSED" as const,
        },
        revocationStatus: "PENDING" as const,
      }),
    },
    gmailConnectionQuery: {
      getStatus: async () => gmailConnection,
    },
    gmailPollingSyncCommands: {
      start: async () => ({
        status: "ACCEPTED" as const,
        workflowId: "backlinks:gmail-polling-sync:private-api",
      }),
      status: async () => ({
        state: "WAITING_FOR_ACCEPTED_SEND" as const,
        workflowId: "backlinks:gmail-polling-sync:private-api",
        pollingIntervalSeconds: 60,
        killSwitchOpen: true,
        acceptedSendCount: 0,
        cursor: null,
      }),
    },
  };
}

async function createApp() {
  return createBacklinksPrivateApi({
    config: {
      BACKLINKS_API_ENABLED: true,
      BACKLINK_API_BODY_LIMIT: 1_048_576,
      BACKLINK_API_REQUEST_TIMEOUT_MS: 5_000,
    },
    platformContextSigningKey: signingKey,
    dependencies: createDependencies(),
    logger: false,
  });
}

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.stop()));
});

describe("private Backlinks API bootstrap", () => {
  it("registers placement operations without browser CORS", async () => {
    const app = await createApp();
    await app.ready();

    const operationIds = Object.values(app.swagger().paths)
      .flatMap((pathItem) => Object.values(pathItem ?? {}))
      .flatMap((operation) =>
        typeof operation === "object"
        && operation !== null
        && "operationId" in operation
        && typeof operation.operationId === "string"
          ? [operation.operationId]
          : [],
      );
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://browser.example" },
    });

    expect(operationIds).toHaveLength(59);
    expect(new Set(operationIds).size).toBe(59);
    expect(operationIds).toContain("backlinksPrivateHealthV1");
    expect(operationIds).toContain("backlinksGetAssessmentV1");
    expect(operationIds).toContain("backlinksCreateDraftJobV1");
    expect(operationIds).toContain("backlinksGetDraftJobV1");
    expect(operationIds).toContain("backlinksGetDraftV1");
    expect(operationIds).toContain("backlinksSaveDraftVersionV1");
    expect(operationIds).toContain("backlinksApproveDraftV1");
    expect(operationIds).toContain("backlinksCreateSendIntentV1");
    expect(operationIds).toContain("backlinksCreateOpportunityV1");
    expect(operationIds).toContain(
      "backlinksCreateManualContactCandidateV1",
    );
    expect(operationIds).toContain("backlinksStartContactEnrichmentV1");
    expect(operationIds).toContain("backlinksGetContactEnrichmentJobV1");
    expect(operationIds).toContain("backlinksRetryContactEnrichmentV1");
    expect(operationIds).toContain("backlinksAddPublicContactCandidateV1");
    expect(operationIds).toContain("backlinksCorrectContactCandidateV1");
    expect(operationIds).toContain("backlinksConnectGmailV1");
    expect(operationIds).toContain("backlinksCompleteGmailConnectionV1");
    expect(operationIds).toContain("backlinksGetGmailConnectionStatusV1");
    expect(operationIds).toContain("backlinksDisconnectGmailV1");
    expect(operationIds).toContain("backlinksStartGmailPollingSyncV1");
    expect(operationIds).toContain("backlinksGetGmailPollingSyncStatusV1");
    expect(operationIds).toContain("backlinksCreatePlacementCandidateV1");
    expect(operationIds).toContain("backlinksConfirmPlacementCandidateV1");
    expect(operationIds).toContain("backlinksRejectPlacementCandidateV1");
    expect(operationIds).toContain("backlinksListLinksV1");
    expect(operationIds).toContain("backlinksGetCandidateLinkV1");
    expect(operationIds).toContain("backlinksGetPlacementLinkV1");
    expect(operationIds).toContain("backlinksListPlacementLifecycleEventsV1");
    expect(operationIds).toContain("backlinksGetPlacementEvidenceV1");
    expect(operationIds).toContain("backlinksReverifyPlacementV1");
    expect(operationIds).toContain("backlinksGetMetricDashboardV1");
    expect(operationIds).toContain("backlinksListPublishedReportsV1");
    expect(operationIds).toContain("backlinksRequestReportExportV1");
    expect(operationIds).toContain("backlinksGetReportExportV1");
    expect(operationIds).toContain(
      "backlinksAuthorizeReportExportDownloadV1",
    );
    expect(operationIds).toContain("backlinksGetSettingsGovernanceV1");
    expect(operationIds).toContain("backlinksUpdateSettingsV1");
    expect(operationIds).toContain("backlinksUpdateKillSwitchV1");
    expect(operationIds).toContain("backlinksListReplyMatchCandidatesV1");
    expect(operationIds).toContain("backlinksConfirmReplyMatchCandidateV1");
    expect(operationIds).toContain("backlinksUnbindReplyMatchV1");
    expect(operationIds).toContain("backlinksListReplyMailMessagesV1");
    expect(operationIds).toContain("backlinksGetReplyMailMessageV1");
    expect(operationIds).toContain("backlinksGetReplyMailThreadV1");
    expect(operationIds).toContain("backlinksReceiveGmailPushV1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    await app.close();
  });

  it("registers Gmail Push as disabled without provider callbacks", async () => {
    const app = await createApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/backlinks/mail/gmail-push",
      headers: { authorization: "Bearer provider-oidc" },
      payload: {
        message: {
          data: Buffer.from(JSON.stringify({
            emailAddress: "owner@example.test",
            historyId: "99141",
          })).toString("base64"),
          messageId: "1410000000001",
        },
        subscription:
          "projects/growthos/subscriptions/backlinks-gmail-push",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "GMAIL_PUSH_WEBHOOK_DISABLED",
    });
    await app.close();
  });

  it("rejects a non-loopback bind unless explicitly allowed", async () => {
    const app = await createApp();

    await expect(
      startBacklinksPrivateApi(app, { host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow("loopback");
    await app.close();
  });

  it("starts on loopback and stops the listener gracefully", async () => {
    const app = await createApp();
    const server = await startBacklinksPrivateApi(app, {
      host: "127.0.0.1",
      port: 0,
    });
    startedServers.push(server);

    const response = await fetch(`${server.address}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    const closed = once(app.server, "close");
    await server.stop();
    startedServers.splice(startedServers.indexOf(server), 1);
    await closed;
    await expect(fetch(`${server.address}/health`)).rejects.toThrow();
  });
});
