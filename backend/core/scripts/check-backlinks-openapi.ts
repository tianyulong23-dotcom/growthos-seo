import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import { createBacklinksModule } from "../src/modules/backlinks/application/backlinks.module.js";
import { createContactCommands } from "../src/modules/backlinks/application/commands/contacts.command.js";
import type {
  createDraftCommands,
  createDraftEditingCommands,
} from "../src/modules/backlinks/application/commands/draft.command.js";
import type { GmailConnectionView } from "../src/modules/backlinks/application/gmail-connection.gateway.js";
import { createOpportunityCommands } from "../src/modules/backlinks/application/commands/opportunities.command.js";
import { createReplyMatchCommands } from "../src/modules/backlinks/application/commands/reply-match.command.js";
import { createPlacementLinksQuery } from "../src/modules/backlinks/application/queries/placement-links.query.js";
import { createRecommendationCommands } from "../src/modules/backlinks/application/commands/recommendations.command.js";
import type { createSendIntentCommands } from "../src/modules/backlinks/application/commands/send-intent.command.js";
import { createAssessmentQuery } from "../src/modules/backlinks/application/queries/assessment.query.js";
import { createOpportunitiesQuery } from "../src/modules/backlinks/application/queries/opportunities.query.js";
import { createRecommendationsQuery } from "../src/modules/backlinks/application/queries/recommendations.query.js";
import { createEmptySummaryQuery } from "../src/modules/backlinks/application/queries/summary.query.js";
import { createDisabledGmailPushWebhook } from "../src/modules/backlinks/application/workflows/mail-push-webhook.js";
import { registerBacklinksAssessmentRoute } from "../src/modules/backlinks/api/assessment.route.js";
import { registerBacklinksContextRoute } from "../src/modules/backlinks/api/context.route.js";
import { registerBacklinksContactsRoutes } from "../src/modules/backlinks/api/contacts.route.js";
import {
  registerBacklinksDraftEditingRoutes,
  registerBacklinksDraftRoutes,
} from "../src/modules/backlinks/api/draft.route.js";
import { registerBacklinksHealthRoute } from "../src/modules/backlinks/api/health.route.js";
import { registerBacklinksGmailConnectionRoutes } from "../src/modules/backlinks/api/gmail-connection.route.js";
import { registerBacklinksGmailMailPushRoute } from "../src/modules/backlinks/api/gmail-mail-push.route.js";
import { registerBacklinksOpenApi } from "../src/modules/backlinks/api/openapi.js";
import { registerBacklinksOpportunitiesRoutes } from "../src/modules/backlinks/api/opportunities.route.js";
import { registerBacklinksOpportunityCommandsRoutes } from "../src/modules/backlinks/api/opportunity-commands.route.js";
import { registerBacklinksPlacementCandidateRoutes } from "../src/modules/backlinks/api/placement-candidates.route.js";
import { registerBacklinksPlacementReviewRoutes } from "../src/modules/backlinks/api/placement-review.route.js";
import { registerBacklinksRecommendationCommandsRoutes } from "../src/modules/backlinks/api/recommendation-commands.route.js";
import { registerBacklinksRecommendationsRoute } from "../src/modules/backlinks/api/recommendations.route.js";
import { registerBacklinksReplyMailRoutes } from "../src/modules/backlinks/api/reply-mail.route.js";
import { registerBacklinksReplyMatchRoutes } from "../src/modules/backlinks/api/reply-match.route.js";
import { registerBacklinksSendIntentRoute } from "../src/modules/backlinks/api/send-intent.route.js";
import { registerBacklinksSummaryRoute } from "../src/modules/backlinks/api/summary.route.js";
import { registerBacklinksLinksRoutes } from "../src/modules/backlinks/api/links.route.js";
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
  return tokens.some((token) =>
    ["provider", "vendor", "database", "db", "prisma", "drizzle", "internal"].includes(
      token,
    ),
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
      create: async () => ({
        sendIntentId: "018f0000-0000-7000-8000-000000000114",
        draftId: "018f0000-0000-7000-8000-000000000011",
        approvedDraftVersionId:
          "018f0000-0000-7000-8000-000000000012",
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
      tokenExpiresAt: "2026-07-27T06:00:00.000Z",
      connectedAt: "2026-07-27T05:00:00.000Z",
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
          versionId: null,
          lastSuccessfulVersionId: null,
        }),
        getDraft: async () => ({
          id: "018f0000-0000-7000-8000-000000000011",
          opportunityId: "018f0000-0000-7000-8000-000000000004",
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
        ...createRecommendationsQuery({ query: async () => ({ rows: [] }) }) },
    });
    await registerBacklinksOpenApi(app);
    registerBacklinksHealthRoute(app, { BACKLINKS_API_ENABLED: true });
    registerBacklinksContextRoute(app, { module });
    registerBacklinksContactsRoutes(app, { module, commands: createContactCommands({ query: async () => ({ rows: [] }) }) });
    registerBacklinksRecommendationsRoute(app, { module });
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
        getStatus: async () => gmailConnection,
      },
    });
    registerBacklinksReplyMatchRoutes(app, {
      module,
      commands: createReplyMatchCommands({
        repository: {
          saveMatchResult: async () => ({ state: "not_found" }),
          listCandidates: async () => ({ state: "not_found" }),
          confirmCandidate: async () => ({ state: "not_found" }),
        },
      }),
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
  if (breakingChanges.length > 0 || sensitiveFields.length > 0) {
    throw new Error(
      [
        breakingChanges.length > 0
          ? `Breaking Backlinks OpenAPI changes:\n- ${breakingChanges.join("\n- ")}`
          : "",
        sensitiveFields.length > 0
          ? `Sensitive Backlinks OpenAPI fields:\n- ${sensitiveFields.join("\n- ")}`
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
