import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import { createBacklinksModule } from "../src/modules/backlinks/application/backlinks.module.js";
import { createContactCommands } from "../src/modules/backlinks/application/commands/contacts.command.js";
import {
  createContactEnrichmentCommands,
} from "../src/modules/backlinks/application/commands/contact-enrichment.command.js";
import type {
  createDraftCommands,
  createDraftEditingCommands,
} from "../src/modules/backlinks/application/commands/draft.command.js";
import type { GmailConnectionView } from "../src/modules/backlinks/application/gmail-connection.gateway.js";
import {
  createCooperationPathOpportunityCommands,
} from "../src/modules/backlinks/application/commands/cooperation-path-opportunities.command.js";
import { createOpportunityCommands } from "../src/modules/backlinks/application/commands/opportunities.command.js";
import { createReplyMatchCommands } from "../src/modules/backlinks/application/commands/reply-match.command.js";
import type {
  NegotiationFactsService,
} from "../src/modules/backlinks/application/services/negotiation-facts.service.js";
import { createPlacementLinksQuery } from "../src/modules/backlinks/application/queries/placement-links.query.js";
import { createRecommendationCommands } from "../src/modules/backlinks/application/commands/recommendations.command.js";
import type { createSendIntentCommands } from "../src/modules/backlinks/application/commands/send-intent.command.js";
import { createAssessmentQuery } from "../src/modules/backlinks/application/queries/assessment.query.js";
import { createOpportunitiesQuery } from "../src/modules/backlinks/application/queries/opportunities.query.js";
import { createRecommendationsQuery } from "../src/modules/backlinks/application/queries/recommendations.query.js";
import { createResourceLibraryQuery } from "../src/modules/backlinks/application/queries/resource-library.query.js";
import { createEmptySummaryQuery } from "../src/modules/backlinks/application/queries/summary.query.js";
import { createDisabledGmailPushWebhook } from "../src/modules/backlinks/application/workflows/mail-push-webhook.js";
import { registerBacklinksAssessmentRoute } from "../src/modules/backlinks/api/assessment.route.js";
import { registerBacklinksContextRoute } from "../src/modules/backlinks/api/context.route.js";
import { registerBacklinksContactsRoutes } from "../src/modules/backlinks/api/contacts.route.js";
import {
  registerBacklinksContactEnrichmentRoutes,
} from "../src/modules/backlinks/api/contact-enrichment.route.js";
import {
  registerBacklinksDraftEditingRoutes,
  registerBacklinksDraftRoutes,
} from "../src/modules/backlinks/api/draft.route.js";
import { registerBacklinkProfileRoutes } from "../src/modules/backlinks/api/backlink-profile.route.js";
import { registerBacklinksHealthRoute } from "../src/modules/backlinks/api/health.route.js";
import { registerBacklinksGmailConnectionRoutes } from "../src/modules/backlinks/api/gmail-connection.route.js";
import { registerBacklinksGmailMailPushRoute } from "../src/modules/backlinks/api/gmail-mail-push.route.js";
import { registerBacklinksOpenApi } from "../src/modules/backlinks/api/openapi.js";
import {
  registerCooperationPathOpportunityCommandsRoutes,
} from "../src/modules/backlinks/api/cooperation-path-opportunity-commands.route.js";
import { registerBacklinksOpportunitiesRoutes } from "../src/modules/backlinks/api/opportunities.route.js";
import { registerBacklinksOpportunityCommandsRoutes } from "../src/modules/backlinks/api/opportunity-commands.route.js";
import { registerBacklinksPlacementCandidateRoutes } from "../src/modules/backlinks/api/placement-candidates.route.js";
import { registerBacklinksPlacementReviewRoutes } from "../src/modules/backlinks/api/placement-review.route.js";
import { registerBacklinksRecommendationCommandsRoutes } from "../src/modules/backlinks/api/recommendation-commands.route.js";
import { registerBacklinksRecommendationsRoute } from "../src/modules/backlinks/api/recommendations.route.js";
import { registerBacklinksResourceLibraryRoute } from "../src/modules/backlinks/api/resource-library.route.js";
import { registerBacklinksReplyMailRoutes } from "../src/modules/backlinks/api/reply-mail.route.js";
import { registerBacklinksReplyMatchRoutes } from "../src/modules/backlinks/api/reply-match.route.js";
import {
  registerBacklinksNegotiationFactsRoutes,
} from "../src/modules/backlinks/api/negotiation-facts.route.js";
import { registerBacklinksSendIntentRoute } from "../src/modules/backlinks/api/send-intent.route.js";
import { registerBacklinksSendIntentListRoute } from "../src/modules/backlinks/api/send-intent.route.js";
import { registerBacklinksSummaryRoute } from "../src/modules/backlinks/api/summary.route.js";
import { registerBacklinksLinksRoutes } from "../src/modules/backlinks/api/links.route.js";
import { registerBacklinksMetricDashboardRoute } from "../src/modules/backlinks/api/metrics/metric-dashboard.route.js";
import { registerBacklinksReportExportRoutes } from "../src/modules/backlinks/api/reports/report-export.route.js";
import { registerBacklinksReportOverviewRoute } from "../src/modules/backlinks/api/reports/report-overview.route.js";
import { registerBacklinksSettingsGovernanceRoutes } from "../src/modules/backlinks/api/settings/settings-governance.route.js";
import { gmailOAuthScopes } from "../src/modules/backlinks/domain/sending/oauth-attempt.js";

export type JsonValue =
  | null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };
type DraftCommands = ReturnType<typeof createDraftCommands>;
type DraftEditingCommands = ReturnType<typeof createDraftEditingCommands>;
type SendIntentCommands = ReturnType<typeof createSendIntentCommands>;

const baselinePath = fileURLToPath(
  new URL("../../contracts/openapi/backlinks.v1.json", import.meta.url),
);

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveFieldName(value: string): boolean {
  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase());
  if (
    tokens.some((token) =>
      ["database", "db", "prisma", "drizzle", "internal"].includes(token),
    )
  ) {
    return true;
  }
  return tokens.some((token) => ["provider", "vendor"].includes(token))
    && tokens.some((token) =>
      [
        "payload",
        "request",
        "response",
        "body",
        "raw",
        "token",
        "secret",
        "credential",
      ].includes(token),
    );
}

export function findSensitiveOpenApiFields(
  value: JsonValue,
  path = "$",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSensitiveOpenApiFields(item, `${path}[${index}]`),
    );
  }
  if (!isJsonObject(value)) {
    return [];
  }

  const properties = value.properties;
  const sensitiveProperties = isJsonObject(properties)
    ? Object.keys(properties)
        .filter(isSensitiveFieldName)
        .map((key) => `${path}.properties.${key}`)
    : [];
  return [
    ...sensitiveProperties,
    ...Object.entries(value).flatMap(([key, child]) =>
      findSensitiveOpenApiFields(child, `${path}.${key}`),
    ),
  ];
}

export function findUnresolvedOpenApiRefs(document: JsonValue): string[] {
  const resolveRef = (ref: string): JsonValue | undefined => {
    if (!ref.startsWith("#/")) return undefined;
    return ref
      .slice(2)
      .split("/")
      .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce<JsonValue | undefined>(
        (value, token) =>
          isJsonObject(value) || Array.isArray(value)
            ? value[token as keyof typeof value]
            : undefined,
        document,
      );
  };
  const visit = (value: JsonValue, path: string): string[] => {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => visit(item, `${path}[${index}]`));
    }
    if (!isJsonObject(value)) return [];
    const ref = value.$ref;
    const ownErrors =
      typeof ref === "string" && resolveRef(ref) === undefined
        ? [`${path} -> ${ref}`]
        : [];
    return [
      ...ownErrors,
      ...Object.entries(value).flatMap(([key, child]) =>
        visit(child, `${path}.${key}`),
      ),
    ];
  };
  return visit(document, "$");
}

export function findBreakingOpenApiChanges(
  baseline: JsonValue,
  current: JsonValue,
  path = "$",
): string[] {
  if (Array.isArray(baseline)) {
    if (!Array.isArray(current)) {
      return [`${path} changed from an array`];
    }
    return baseline.flatMap((expected) =>
      current.some(
        (actual) =>
          findBreakingOpenApiChanges(expected, actual, path).length === 0,
      )
        ? []
        : [`${path} lost array item ${JSON.stringify(expected)}`],
    );
  }

  if (isJsonObject(baseline)) {
    if (!isJsonObject(current)) {
      return [`${path} changed from an object`];
    }
    return Object.entries(baseline).flatMap(([key, expected]) =>
      key in current
        ? findBreakingOpenApiChanges(expected, current[key], `${path}.${key}`)
        : [`${path}.${key} is missing`],
    );
  }

  return Object.is(baseline, current)
    ? []
    : [`${path} changed from ${JSON.stringify(baseline)} to ${JSON.stringify(current)}`];
}

export async function generateBacklinksOpenApi(): Promise<JsonObject> {
  const app = Fastify({ logger: false });
  try {
    const draftCommands: DraftCommands = {
      create: async () => ({
        jobId: "018f0000-0000-7000-8000-000000000010",
        draftId: "018f0000-0000-7000-8000-000000000011",
        status: "QUEUED",
        contactId: "018f0000-0000-7000-8000-000000000013",
        contactVersion: 1,
        evidenceSnapshotId: "018f0000-0000-7000-8000-000000000014",
        workflowId: "draft-generation:018f0000-0000-7000-8000-000000000010",
        generationMode: "MODEL",
        replayed: false,
      }),
    };
    const draftEditingCommands: DraftEditingCommands = {
      saveManualVersion: async () => ({
        draftId: "018f0000-0000-7000-8000-000000000011",
        versionId: "018f0000-0000-7000-8000-000000000012",
        draftVersion: 2,
        status: "draft",
      }),
      approve: async () => ({
        draftId: "018f0000-0000-7000-8000-000000000011",
        versionId: "018f0000-0000-7000-8000-000000000012",
        draftVersion: 3,
        status: "approved",
      }),
    };
    const sendIntentCommands: SendIntentCommands = {
      preflight: async () => ({
        allowed: true,
        deliveryState: "NOT_SENT",
        checkedAt: "2026-08-07T10:14:00.000Z",
        gmail: {
          connectionId: "018f0000-0000-7000-8000-000000000020",
          primaryEmail: "owner@example.com",
          connectionStatus: "CONNECTED",
          sendAvailability: "AVAILABLE",
          mailSyncCapability: true,
        },
      }),
      create: async () => ({
        sendIntentId: "018f0000-0000-7000-8000-000000000114",
        sendSnapshotId: "018f0000-0000-7000-8000-000000000115",
        draftId: "018f0000-0000-7000-8000-000000000011",
        approvedDraftVersionId:
          "018f0000-0000-7000-8000-000000000012",
        contactId: "018f0000-0000-7000-8000-000000000013",
        contactVersion: 1,
        status: "READY",
        version: 1,
        requestedSendAt: "2026-07-27T10:14:00.000Z",
      }),
    };
    const gmailConnection: GmailConnectionView = {
      connectionId: "018f0000-0000-7000-8000-000000000020",
      version: 1,
      primaryEmail: "owner@example.com",
      displayName: "Example Owner",
      hostedDomain: "example.com",
      grantedScopes: gmailOAuthScopes,
      connectionStatus: "CONNECTED",
      sendAvailability: "AVAILABLE",
      mailSyncCapability: true,
      tokenExpiresAt: "2026-07-27T06:00:00.000Z",
      connectedAt: "2026-07-27T05:00:00.000Z",
      affectedProjectCount: 2,
      recentErrorCategory: null,
    };
    const gmailReadiness = {
      evaluatedAt: "2026-08-18T02:00:00.000Z",
      connection: { state: "CONNECTED" as const, ready: true },
      send: { state: "WAITING_FOR_SEND_CONTEXT" as const, ready: false },
      sync: {
        state: "WAITING_FOR_ACCEPTED_SEND" as const,
        ready: true,
      },
      blockers: [{
        code: "SEND_CONTEXT_REQUIRED" as const,
        capability: "SEND" as const,
        owner: "USER" as const,
        retrySafe: true,
        recoveryAction: "OPEN_APPROVED_DRAFT" as const,
        detail:
          "Open an approved draft and recipient to evaluate send-specific readiness.",
      }],
      primaryBlocker: {
        code: "SEND_CONTEXT_REQUIRED" as const,
        capability: "SEND" as const,
        owner: "USER" as const,
        retrySafe: true,
        recoveryAction: "OPEN_APPROVED_DRAFT" as const,
        detail:
          "Open an approved draft and recipient to evaluate send-specific readiness.",
      },
    };
    const replyMailMessage = {
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
    };
    const module = createBacklinksModule({
      projectContext: {
        resolve: async () => {
          throw new Error("OpenAPI generation does not resolve project context.");
        },
      },
      queries: { ...createEmptySummaryQuery(),
        ...createAssessmentQuery({ query: async () => ({ rows: [] }) }),
        getJob: async () => ({
          id: "018f0000-0000-7000-8000-000000000010",
          draftId: "018f0000-0000-7000-8000-000000000011",
          status: "QUEUED",
          contactId: "018f0000-0000-7000-8000-000000000013",
          contactVersion: 1,
          versionId: null,
          lastSuccessfulVersionId: null,
          queuedAt: "2026-07-27T05:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          deadlineAt: "2026-07-27T05:02:00.000Z",
          queueWaitMs: null,
          latencyMs: null,
          persistenceLatencyMs: null,
          attemptCount: 0,
          lastErrorCategory: null,
        }),
        findLatestJob: async () => null,
        getDraft: async () => ({
          id: "018f0000-0000-7000-8000-000000000011",
          opportunityId: "018f0000-0000-7000-8000-000000000004",
          contactId: "018f0000-0000-7000-8000-000000000013",
          contactVersion: 1,
          status: "draft",
          draftVersion: 1,
          approvedVersionId: null,
          currentVersion: {
            id: "018f0000-0000-7000-8000-000000000012",
            versionNo: 1,
            subjectText: "Draft subject",
            bodyText: "Draft body",
            bodyDocument: {
              type: "doc",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Draft body" }],
              }],
            },
            source: "MODEL",
            createdAt: "2026-07-27T05:00:00.000Z",
          },
        }),
        getSendIntent: async () => ({
          sendIntentId: "018f0000-0000-7000-8000-000000000014",
          draftId: "018f0000-0000-7000-8000-000000000011",
          status: "READY",
          version: 1,
          requestedSendAt: "2026-07-27T05:00:00.000Z",
          updatedAt: "2026-07-27T05:00:00.000Z",
          attempt: null,
        }),
        listSendIntents: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        listMailMessages: async () => ({
          items: [],
          nextCursor: null,
          hasMore: false,
        }),
        getMailMessage: async () => replyMailMessage,
        getMailThread: async () => ({
          id: replyMailMessage.threadId,
          latestMessageAt: null,
          messageCount: 0,
          version: 1,
          messages: [],
        }),
        ...createOpportunitiesQuery({ query: async () => ({ rows: [] }) }),
        ...createPlacementLinksQuery({ query: async () => ({ rows: [] }) }),
        ...createRecommendationsQuery({ query: async () => ({ rows: [] }) }),
        ...createResourceLibraryQuery({ query: async () => ({ rows: [] }) }) },
    });
    await registerBacklinksOpenApi(app);
    registerBacklinksHealthRoute(app, { BACKLINKS_API_ENABLED: true });
    registerBacklinksContextRoute(app, { module });
    registerBacklinksContactsRoutes(app, { module, commands: createContactCommands({ query: async () => ({ rows: [] }) }) });
    registerBacklinksContactEnrichmentRoutes(app, {
      module,
      commands: createContactEnrichmentCommands(
        { query: async () => ({ rows: [] }) },
        {
          maxPages: 8,
          maxDepth: 2,
          maxAttempts: 3,
          browserAllowed: true,
        },
      ),
    });
    registerBacklinksRecommendationsRoute(app, {
      module,
      runningBuildId: "openapi-build",
    });
    registerBacklinksResourceLibraryRoute(app, { module });
    registerBacklinksOpportunitiesRoutes(app, { module });
    registerBacklinksOpportunityCommandsRoutes(app, { module,
      commands: createOpportunityCommands({
        createFromRecommendation: async () => ({
          state: "not_found", requestHash: "openapi" }),
        transitionBusinessStage: async () => ({
          state: "not_found", requestHash: "openapi" }),
        patchManagement: async () => ({
          state: "not_found", requestHash: "openapi" }),
      }) });
    registerCooperationPathOpportunityCommandsRoutes(app, {
      module,
      commands: createCooperationPathOpportunityCommands({
        createFromVerifiedPath: async () => ({
          state: "not_found",
          requestHash: "openapi",
        }),
        patchManualContent: async () => ({
          state: "not_found",
          requestHash: "openapi",
        }),
        transitionManualAction: async () => ({
          state: "not_found",
          requestHash: "openapi",
        }),
      }),
    });
    registerBacklinksPlacementCandidateRoutes(app, {
      module,
      command: {
        execute: async () => ({
          candidateId: "018f0000-0000-7000-8000-000000000147",
          status: "PENDING_MATCH",
          matchStatus: "UNMATCHED",
          initialValidationStatus: "PENDING",
          version: 1,
          countsTowardKpi: false,
          replayed: false,
        }),
      },
    });
    registerBacklinksPlacementReviewRoutes(app, {
      module,
      command: {
        confirm: async () => ({
          action: "manual_confirm",
          candidateId: "018f0000-0000-7000-8000-000000000149",
          candidateStatus: "PROMOTED",
          initialValidationStatus: "MANUALLY_CONFIRMED",
          candidateVersion: 2,
          validationRunId: "018f0000-0000-7000-8000-000000000150",
          placementId: "018f0000-0000-7000-8000-000000000151",
          placementVersion: 1,
          monitoringOutboxEventId: "018f0000-0000-7000-8000-000000000152",
          lifecycleEventId: "018f0000-0000-7000-8000-000000000153",
          auditEventId: "018f0000-0000-7000-8000-000000000154",
          countsTowardKpi: true,
        }),
        reject: async () => ({
          action: "reject",
          candidateId: "018f0000-0000-7000-8000-000000000149",
          candidateStatus: "REJECTED",
          initialValidationStatus: "INVALID",
          candidateVersion: 2,
          lifecycleEventId: "018f0000-0000-7000-8000-000000000153",
          auditEventId: "018f0000-0000-7000-8000-000000000154",
          countsTowardKpi: false,
        }),
      },
    });
    registerBacklinksLinksRoutes(app, {
      module,
      reverifyCommand: {
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
    });
    registerBacklinkProfileRoutes(app, {
      module,
      service: {
        getProfile: async () => ({
          canonicalDomain: "example.com",
          snapshot: null,
          health: null,
          sync: {
            providerEnabled: false,
            status: "waiting_provider",
            lastSyncAt: null,
            nextSyncAt: null,
            estimatedCostMicros: 27_600,
            actualCostMicros: 0,
            stale: false,
            partial: false,
            providerInputRequired: true,
          },
        }),
        listInventory: async (_context, input) => ({
          items: [],
          page: input.page,
          pageSize: input.pageSize,
          totalCount: 0,
          totalPages: 0,
        }),
        importInventory: async () => ({
          inventoryItemId: "018f0000-0000-7000-8000-000000000211",
          sourceUrl: "https://publisher.example/article",
          targetUrl: "https://example.com/",
          tier: "C",
          monitoringStatus: "enabled",
          nextCheckAt: "2026-08-06T00:00:00.000Z",
          replayed: false,
        }),
        updateInventoryPolicy: async () => ({
          inventoryItemId: "018f0000-0000-7000-8000-000000000211",
          tier: "A",
          importance: "important",
          monitoringStatus: "enabled",
          policyVersion: "inventory-monitoring-v1",
          policyRevision: 2,
          nextCheckAt: "2026-08-06T00:00:00.000Z",
          providerOnlyReason: null,
        }),
        requestInventoryCheck: async () => ({
          inventoryItemId: "018f0000-0000-7000-8000-000000000211",
          runId: "018f0000-0000-7000-8000-000000000212",
          observationId: "018f0000-0000-7000-8000-000000000213",
          workflowId:
            "backlinks:placement-monitoring:018f0000-0000-7000-8000-000000000212",
          scheduledFor: "2026-08-06T00:00:00.000Z",
          replayed: false,
          monitorInput: {
            organizationId: "018f0000-0000-7000-8000-000000000001",
            workspaceId: "018f0000-0000-7000-8000-000000000002",
            websiteProjectId: "018f0000-0000-7000-8000-000000000003",
            placementId: "018f0000-0000-7000-8000-000000000211",
            monitorPolicyId: "018f0000-0000-7000-8000-000000000211",
            policyVersion: "inventory-monitoring-v1",
            scheduledFor: "2026-08-06T00:00:00.000Z",
            runId: "018f0000-0000-7000-8000-000000000212",
            observationId: "018f0000-0000-7000-8000-000000000213",
            workerId: "user-openapi",
            now: "2026-08-06T00:00:00.000Z",
          },
        }),
        listDirectObservations: async () => ({ items: [] }),
        requestSync: async () => ({
          jobId: "018f0000-0000-7000-8000-000000000201",
          workflowId:
            "backlinks:backlink-profile-sync:018f0000-0000-7000-8000-000000000201",
          status: "waiting_provider",
          canonicalDomain: "example.com",
          estimatedCostMicros: 27_600,
          providerInputRequired: true,
          replayed: false,
        }),
        getSyncJob: async () => ({
          jobId: "018f0000-0000-7000-8000-000000000201",
          status: "waiting_provider",
          canonicalDomain: "example.com",
          totalCount: null,
          pulledCount: 0,
          inventoryCoverage: null,
          estimatedCostMicros: 27_600,
          actualCostMicros: 0,
          nextSyncAt: null,
          errorCode: "PROVIDER_INPUT_REQUIRED",
          startedAt: null,
          finishedAt: null,
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        }),
      },
    });
    registerBacklinksMetricDashboardRoute(app, {
      projectContext: module.projectContext,
      query: {
        getDashboard: async (input) => ({
          timezone: input.timezone,
          from: input.from,
          to: input.to,
          asOf: input.asOf,
          summary: [],
          trends: [],
        }),
      },
    });
    registerBacklinksReportOverviewRoute(app, {
      projectContext: module.projectContext,
      query: {
        listPublished: async () => [],
      },
    });
    registerBacklinksReportExportRoutes(app, {
      projectContext: module.projectContext,
      workflow: {
        request: async (input) => ({
          id: "018f0000-0000-7000-8000-000000000169",
          ...input.scope,
          reportKey: input.reportKey,
          reportRevisionId: input.reportRevisionId,
          format: input.format,
          status: "queued",
          requestedBy: input.requestedBy,
          correlationId: input.correlationId,
          objectReference: null,
          createdAt: new Date("2026-07-29T01:00:00.000Z"),
          completedAt: null,
          expiresAt: null,
          failureCode: null,
        }),
        get: async () => ({
          id: "018f0000-0000-7000-8000-000000000169",
          organizationId: "organization-openapi",
          workspaceId: "workspace-openapi",
          websiteProjectId: "project-openapi",
          reportKey: "weekly-performance",
          reportRevisionId:
            "018f0000-0000-7000-8000-000000000165",
          format: "csv",
          status: "completed",
          requestedBy: "user-openapi",
          correlationId: "request-openapi",
          objectReference: null,
          createdAt: new Date("2026-07-29T01:00:00.000Z"),
          completedAt: new Date("2026-07-29T01:01:00.000Z"),
          expiresAt: new Date("2026-07-30T01:01:00.000Z"),
          failureCode: null,
        }),
        run: async () => {
          throw new Error("OpenAPI generation must not render exports.");
        },
        authorizeDownload: async () => ({
          url: "https://objects.example.test/signed/export.csv",
          expiresAt: new Date("2026-07-29T01:10:00.000Z"),
        }),
      },
    });
    registerBacklinksSettingsGovernanceRoutes(app, {
      projectContext: module.projectContext,
      service: {
        getView: async () => ({
          settings: {
            id: "settings-openapi",
            version: 1,
            values: {
              reportingTimezone: "UTC",
              reportLookbackDays: 30,
              exportExpiryHours: 24,
            },
          },
          killSwitches: [{
            capability: "DATA_PROVIDER",
            provider: "DataForSEO",
            effectiveBlocked: true,
            sourceLayer: "organization",
            sourceScopeId: "organization-openapi",
            sourceVersion: 1,
            editable: false,
          }],
          editableKillSwitchLayers: ["project", "provider"],
          retention: {
            id: "retention-openapi",
            version: 1,
            rules: [],
            exceptions: [],
          },
        }),
        updateSettings: async (input) => ({
          id: "settings-openapi",
          version: input.expectedVersion + 1,
          values: input.values,
        }),
        updateKillSwitch: async (input) => ({
          capability: input.capability,
          provider: input.provider,
          effectiveBlocked: input.blocked,
          sourceLayer: input.layer,
          sourceScopeId: input.scope.websiteProjectId,
          sourceVersion: input.expectedVersion + 1,
          editable: true,
        }),
      },
    });
    registerBacklinksRecommendationCommandsRoutes(app, { module, commands: createRecommendationCommands({ query: async () => ({ rows: [] }) }) });
    registerBacklinksAssessmentRoute(app, { module });
    registerBacklinksDraftRoutes(app, { module, commands: draftCommands });
    registerBacklinksDraftEditingRoutes(app, {
      module,
      commands: draftEditingCommands,
    });
    registerBacklinksSendIntentRoute(app, {
      module,
      commands: sendIntentCommands,
    });
    registerBacklinksSendIntentListRoute(app, { module });
    registerBacklinksGmailConnectionRoutes(app, {
      module,
      commands: {
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
            connectionStatus: "DISCONNECTED",
            sendAvailability: "PAUSED",
          },
          revocationStatus: "PENDING",
        }),
      },
      query: {
        getStatus: async () => ({
          accounts: [gmailConnection],
          selectedConnection: gmailConnection,
          readiness: gmailReadiness,
        }),
      },
      syncCommands: {
        start: async () => ({
          status: "ACCEPTED",
          workflowId: "backlinks:gmail-polling-sync:openapi",
        }),
        status: async () => ({
          state: "POLLING",
          workflowId: "backlinks:gmail-polling-sync:openapi",
          pollingIntervalSeconds: 60,
          killSwitchOpen: true,
          acceptedSendCount: 1,
          lastSuccessfulSyncAt: "2026-08-04T00:01:00.000Z",
          lastError: null,
          nextRetryAt: null,
          cursor: {
            historyId: "12345",
            initialSyncCompletedAt: "2026-08-04T00:00:00.000Z",
            lastSyncedAt: "2026-08-04T00:01:00.000Z",
            version: 1,
          },
        }),
      },
    });
    registerBacklinksReplyMatchRoutes(app, {
      module,
      commands: createReplyMatchCommands({
        repository: {
          saveMatchResult: async () => ({ state: "not_found" }),
          listCandidates: async () => ({ state: "not_found" }),
          confirmCandidate: async () => ({ state: "not_found" }),
          unbindCandidate: async () => ({ state: "not_found" }),
        },
      }),
    });
    const negotiationFact = {
      id: "018f0000-0000-7000-8000-000000000171",
      inboundMessageId: "018f0000-0000-7000-8000-000000000172",
      opportunityId: "018f0000-0000-7000-8000-000000000173",
      factKey: "placement_price",
      factVersion: 1,
      factType: "money",
      rawValue: "$120",
      normalizedValue: { amount: 120, currency: "USD" },
      factAuthority: "INFERRED" as const,
      reviewStatus: "PENDING" as const,
      extractorType: "RULE" as const,
      extractorVersion: "negotiation-rule-v1",
      confidenceScore: 0.9,
      evidenceText: "Our placement price is $120.",
      evidenceStart: 23,
      evidenceEnd: 27,
      supersedesFactVersionId: null,
      decidedBy: null,
      decidedAt: null,
      schemaVersion: 1,
      createdAt: "2026-08-18T00:00:00.000Z",
      createdBy: "reply-classifier",
    };
    const negotiationFactsService: NegotiationFactsService = {
      list: async () => ({
        inboundMessageId: negotiationFact.inboundMessageId,
        opportunityId: negotiationFact.opportunityId,
        items: [negotiationFact],
      }),
      decide: async (input) => ({
        decision: input.decision,
        replayed: false,
        appendedFactVersionIds: [
          "018f0000-0000-7000-8000-000000000174",
        ],
        latestFact: {
          ...negotiationFact,
          id: "018f0000-0000-7000-8000-000000000174",
          factVersion: 2,
          factAuthority: "MANUAL",
          reviewStatus:
            input.decision === "REJECT" ? "REJECTED" : "CONFIRMED",
          extractorType: "MANUAL",
          extractorVersion: "manual-review-v1",
          confidenceScore: 1,
          decidedBy: "user-openapi",
          decidedAt: "2026-08-18T00:01:00.000Z",
          createdAt: "2026-08-18T00:01:00.000Z",
          createdBy: "user-openapi",
        },
      }),
    };
    registerBacklinksNegotiationFactsRoutes(app, {
      module,
      service: negotiationFactsService,
    });
    registerBacklinksReplyMailRoutes(app, { module });
    registerBacklinksGmailMailPushRoute(app, {
      webhook: createDisabledGmailPushWebhook(),
    });
    registerBacklinksSummaryRoute(app, { module });
    await app.ready();
    return JSON.parse(JSON.stringify(app.swagger())) as JsonObject;
  } finally {
    await app.close();
  }
}

export async function writeBacklinksOpenApiBaseline(): Promise<void> {
  const document = await generateBacklinksOpenApi();
  const sensitiveFields = findSensitiveOpenApiFields(document);
  if (sensitiveFields.length > 0) {
    throw new Error(
      `Sensitive Backlinks OpenAPI fields:\n- ${sensitiveFields.join("\n- ")}`,
    );
  }
  const unresolvedRefs = findUnresolvedOpenApiRefs(document);
  if (unresolvedRefs.length > 0) {
    throw new Error(
      `Unresolved Backlinks OpenAPI refs:\n- ${unresolvedRefs.join("\n- ")}`,
    );
  }
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(
    `Backlinks OpenAPI baseline written: ${Object.keys(document.paths ?? {}).length} paths`,
  );
}

export async function checkBacklinksOpenApi(): Promise<void> {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as JsonValue;
  const current = await generateBacklinksOpenApi();
  const breakingChanges = findBreakingOpenApiChanges(baseline, current);
  const sensitiveFields = findSensitiveOpenApiFields(current);
  const unresolvedRefs = findUnresolvedOpenApiRefs(current);
  if (
    breakingChanges.length > 0 ||
    sensitiveFields.length > 0 ||
    unresolvedRefs.length > 0
  ) {
    throw new Error(
      [
        breakingChanges.length > 0
          ? `Breaking Backlinks OpenAPI changes:\n- ${breakingChanges.join("\n- ")}`
          : "",
        sensitiveFields.length > 0
          ? `Sensitive Backlinks OpenAPI fields:\n- ${sensitiveFields.join("\n- ")}`
          : "",
        unresolvedRefs.length > 0
          ? `Unresolved Backlinks OpenAPI refs:\n- ${unresolvedRefs.join("\n- ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  console.log(
    `Backlinks OpenAPI baseline valid: ${Object.keys(current.paths ?? {}).length} paths`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entrypoint)
) {
  const action = process.argv.includes("--write")
    ? writeBacklinksOpenApiBaseline
    : checkBacklinksOpenApi;
  action().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
