import { readFileSync, writeFileSync } from "node:fs";

import { createBacklinksPrivateApi, startBacklinksPrivateApi } from
  "../../../../src/modules/backlinks/api/private-server.js";
import { createBacklinksModule } from
  "../../../../src/modules/backlinks/application/backlinks.module.js";
import { createPlacementLinksQuery } from
  "../../../../src/modules/backlinks/application/queries/placement-links.query.js";
import {
  createProjectContext,
  createTenantContext,
} from "../../../../src/modules/backlinks/domain/context/index.js";

const signingKey = process.env.PLATFORM_CONTEXT_SIGNING_KEY
  ?? "test-only-platform-context-key-32-bytes";
const counterPath = process.env.BACKLINKS_COMMAND_COUNTER
  ?? "/tmp/backlinks-command-count";
const websiteProjectKey = process.env.WEBSITE_PROJECT_KEY ?? "project-key";

function incrementCommandCount(): void {
  const current = Number.parseInt(readFileSync(counterPath, "utf8"), 10);
  writeFileSync(counterPath, String(current + 1), "utf8");
}

async function main(): Promise<void> {
  writeFileSync(counterPath, "0", "utf8");
  const tenant = createTenantContext({
    organizationId: "org-gateway",
    workspaceId: "workspace-gateway",
  });
  const project = createProjectContext({
    websiteProjectId: "project-gateway",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-runtime",
    promotionTargetVersionId: "target-runtime",
  });
  const app = await createBacklinksPrivateApi({
    config: {
      BACKLINKS_API_ENABLED: true,
      BACKLINK_API_BODY_LIMIT: 1_048_576,
      BACKLINK_API_REQUEST_TIMEOUT_MS: 5_000,
    },
    platformContextSigningKey: signingKey,
    dependencies: {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor, websiteProjectKey: requestedKey }) => {
            if (requestedKey !== websiteProjectKey) {
              throw new TypeError("Unexpected runtime project key.");
            }
            return { actor, tenant, project };
          },
        },
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
              status: "SUCCEEDED" as const,
              attemptCount: 1,
              sourceReleaseIds: ["release-runtime"],
              startedAt: "2026-07-27T00:00:00.000Z",
              finishedAt: "2026-07-27T00:01:00.000Z",
              errorCode: null,
            },
            result: {
              snapshotId: "a8646413-5769-4ee0-850a-87a977a38b39",
              snapshotVersion: 1,
              isCurrent: true,
              availability: "available" as const,
              stale: false,
              sourceReleaseIds: ["release-runtime"],
              generatedAt: "2026-07-27T00:01:00.000Z",
              payload: {},
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
          lifecycleEventId: "lifecycle-runtime-contact",
          auditEventId: "audit-runtime-contact",
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
          lifecycleEventId: "lifecycle-runtime-placement",
          auditEventId: "audit-runtime-placement",
          countsTowardKpi: true as const,
        }),
        reject: async () => ({
          action: "reject" as const,
          candidateId: "018f0000-0000-7000-8000-000000000149",
          candidateStatus: "REJECTED" as const,
          initialValidationStatus: "INVALID" as const,
          candidateVersion: 2,
          lifecycleEventId: "lifecycle-runtime-placement",
          auditEventId: "audit-runtime-placement",
          countsTowardKpi: false as const,
        }),
      },
      recommendationCommands: {
        reject: async () => {
          incrementCommandCount();
          return {
            recommendationId: "018f0000-0000-7000-8000-000000000003",
            status: "rejected" as const,
            version: 2,
            lifecycleEventId: "lifecycle-runtime-reject",
            auditEventId: "audit-runtime-reject",
            replayed: false,
          };
        },
        requestRefill: async () => ({
          operationId: "018f0000-0000-7000-8000-000000000155",
          jobId: "job-runtime",
          workflowId: "workflow-runtime",
          status: "queued" as const,
          version: 1,
          lifecycleEventId: "lifecycle-runtime-refill",
          auditEventId: "audit-runtime-refill",
          replayed: false,
        }),
        cancelQueuedRefill: async () => ({
          jobId: "018f0000-0000-7000-8000-000000000156",
          refillId: "018f0000-0000-7000-8000-000000000157",
          outboxEventId: "018f0000-0000-7000-8000-000000000158",
          recommendationContextVersionId:
            "018f0000-0000-7000-8000-000000000159",
          visiblePoolGeneration: 1,
          status: "cancelled" as const,
          outboxStatus: "published" as const,
          dispatchDisposition: "cancelled_before_dispatch" as const,
          policyState: "idle" as const,
          reasonCode: "read_side_effect_cleanup" as const,
          version: 2,
          lifecycleEventId: "lifecycle-runtime-refill-cancel",
          auditEventId: "audit-runtime-refill-cancel",
          replayed: false,
        }),
        closeDuplicateRefill: async () => ({
          duplicateJobId: "018f0000-0000-7000-8000-000000000160",
          canonicalJobId: "018f0000-0000-7000-8000-000000000161",
          status: "cancelled" as const,
          reasonCode: "duplicate_recovery_owner" as const,
          version: 2,
          lifecycleEventId: "lifecycle-runtime-refill-close",
          auditEventId: "audit-runtime-refill-close",
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
        request: async () => {
          throw new Error("Runtime fixture does not request exports.");
        },
        run: async () => {
          throw new Error("Runtime fixture does not render exports.");
        },
        get: async () => {
          throw new Error("Runtime fixture does not read exports.");
        },
        authorizeDownload: async () => {
          throw new Error("Runtime fixture does not authorize exports.");
        },
      },
      settingsGovernanceService: {
        getView: async () => ({
          settings: {
            id: "settings-runtime",
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
            id: "retention-runtime",
            version: 1,
            rules: [],
            exceptions: [],
          },
        }),
        updateSettings: async () => {
          throw new Error("Runtime fixture does not update settings.");
        },
        updateKillSwitch: async () => {
          throw new Error("Runtime fixture does not update kill switches.");
        },
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
    },
    logger: false,
  });
  const server = await startBacklinksPrivateApi(app, {
    host: "0.0.0.0",
    port: Number.parseInt(process.env.BACKLINKS_PORT ?? "7301", 10),
    allowNonLoopback: true,
  });

  process.stdout.write(`BACKLINKS_RUNTIME_READY=${server.address}\n`);
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
