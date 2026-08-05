import Fastify, { type FastifyInstance } from "fastify";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createContactCommands } from "../application/commands/contacts.command.js";
import type {
  createDraftCommands,
  createDraftEditingCommands,
} from "../application/commands/draft.command.js";
import type { createGmailConnectionCommands } from "../application/commands/gmail-connection.command.js";
import type { createOpportunityCommands } from "../application/commands/opportunities.command.js";
import type { createPlacementCandidateCommand } from "../application/commands/placement-candidate.command.js";
import type { createPlacementReverifyCommand } from "../application/commands/placement-reverify.command.js";
import type { createPlacementReviewCommand } from "../application/commands/placement-review.command.js";
import type { createRecommendationCommands } from "../application/commands/recommendations.command.js";
import type { createReplyMatchCommands } from "../application/commands/reply-match.command.js";
import type { createSendIntentCommands } from "../application/commands/send-intent.command.js";
import type { AssessmentQuery } from "../application/queries/assessment.query.js";
import type { DraftQuery } from "../application/queries/draft.query.js";
import type { createGmailConnectionQuery } from "../application/queries/gmail-connection.query.js";
import type { OpportunitiesQuery } from "../application/queries/opportunities.query.js";
import type { PlacementLinksQuery } from "../application/queries/placement-links.query.js";
import type { RecommendationsQuery } from "../application/queries/recommendations.query.js";
import type { ReplyMailQuery } from "../application/queries/reply-mail.query.js";
import type { SummaryQuery } from "../application/queries/summary.query.js";
import {
  createDisabledGmailPushWebhook,
  type GmailPushWebhookHandler,
} from "../application/workflows/mail-push-webhook.js";
import type { BacklinksConfig } from "../config/index.js";
import { registerBacklinksAssessmentRoute } from "./assessment.route.js";
import { registerBacklinksContactsRoutes } from "./contacts.route.js";
import { registerBacklinksContextRoute } from "./context.route.js";
import {
  registerBacklinksDraftEditingRoutes,
  registerBacklinksDraftRoutes,
} from "./draft.route.js";
import { registerBacklinksGmailConnectionRoutes } from "./gmail-connection.route.js";
import { registerBacklinksGmailMailPushRoute } from "./gmail-mail-push.route.js";
import { registerBacklinksHealthRoute } from "./health.route.js";
import { registerBacklinksRequestLoggingHook } from "./hooks/request-logging.hook.js";
import { registerBacklinksLinksRoutes } from "./links.route.js";
import { registerBacklinksOpenApi } from "./openapi.js";
import { registerBacklinksOpportunitiesRoutes } from "./opportunities.route.js";
import { registerBacklinksOpportunityCommandsRoutes } from "./opportunity-commands.route.js";
import { registerBacklinksPlacementCandidateRoutes } from "./placement-candidates.route.js";
import { registerBacklinksPlacementReviewRoutes } from "./placement-review.route.js";
import { registerBacklinksPlatformContextConsumer } from "./platform-request-context.js";
import { registerBacklinksRecommendationCommandsRoutes } from "./recommendation-commands.route.js";
import { registerBacklinksRecommendationsRoute } from "./recommendations.route.js";
import { registerBacklinksReplyMailRoutes } from "./reply-mail.route.js";
import { registerBacklinksReplyMatchRoutes } from "./reply-match.route.js";
import { registerBacklinksSendIntentRoute } from "./send-intent.route.js";
import { registerBacklinksSummaryRoute } from "./summary.route.js";

type BacklinksApiQueries =
  AssessmentQuery
  & DraftQuery
  & OpportunitiesQuery
  & PlacementLinksQuery
  & RecommendationsQuery
  & ReplyMailQuery
  & SummaryQuery;
type ContactCommands = ReturnType<typeof createContactCommands>;
type DraftCommands = ReturnType<typeof createDraftCommands>;
type DraftEditingCommands = ReturnType<typeof createDraftEditingCommands>;
type GmailConnectionCommands = ReturnType<typeof createGmailConnectionCommands>;
type GmailConnectionQuery = ReturnType<typeof createGmailConnectionQuery>;
type OpportunityCommands = ReturnType<typeof createOpportunityCommands>;
type PlacementCandidateCommand = ReturnType<typeof createPlacementCandidateCommand>;
type PlacementReverifyCommand = ReturnType<typeof createPlacementReverifyCommand>;
type PlacementReviewCommand = ReturnType<typeof createPlacementReviewCommand>;
type RecommendationCommands = ReturnType<typeof createRecommendationCommands>;
type ReplyMatchCommands = ReturnType<typeof createReplyMatchCommands>;
type SendIntentCommands = ReturnType<typeof createSendIntentCommands>;

export type BacklinksPrivateApiDependencies = Readonly<{
  module: BacklinksModule<BacklinksApiQueries>;
  contactCommands: ContactCommands;
  draftCommands: DraftCommands;
  draftEditingCommands: DraftEditingCommands;
  gmailConnectionCommands: GmailConnectionCommands;
  gmailConnectionQuery: GmailConnectionQuery;
  opportunityCommands: OpportunityCommands;
  placementCandidateCommand: PlacementCandidateCommand;
  placementReverifyCommand: PlacementReverifyCommand;
  placementReviewCommand: PlacementReviewCommand;
  recommendationCommands: RecommendationCommands;
  replyMatchCommands: ReplyMatchCommands;
  sendIntentCommands: SendIntentCommands;
  gmailPushWebhook?: GmailPushWebhookHandler;
}>;

export type CreateBacklinksPrivateApiOptions = Readonly<{
  config: BacklinksConfig;
  platformContextSigningKey: string | Buffer;
  dependencies: BacklinksPrivateApiDependencies;
  logger?: boolean;
}>;

export type StartBacklinksPrivateApiOptions = Readonly<{
  host?: string;
  port: number;
  allowNonLoopback?: boolean;
}>;

export type StartedBacklinksPrivateApi = Readonly<{
  address: string;
  stop(): Promise<void>;
}>;

const privateHosts = new Set(["127.0.0.1", "::1", "localhost"]);

function assertPrivateBind(
  host: string,
  allowNonLoopback: boolean,
): void {
  if (!allowNonLoopback && !privateHosts.has(host.toLowerCase())) {
    throw new TypeError(
      "Backlinks private API must bind to a loopback host unless an explicit private-network override is provided.",
    );
  }
}

export async function createBacklinksPrivateApi(
  options: CreateBacklinksPrivateApiOptions,
): Promise<FastifyInstance> {
  if (!options.config.BACKLINKS_API_ENABLED) {
    throw new TypeError("Backlinks private API is disabled.");
  }

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: options.config.BACKLINK_API_BODY_LIMIT,
    requestTimeout: options.config.BACKLINK_API_REQUEST_TIMEOUT_MS,
  });
  await registerBacklinksOpenApi(app);
  registerBacklinksRequestLoggingHook(app);
  registerBacklinksPlatformContextConsumer(app, {
    signingKey: options.platformContextSigningKey,
  });
  registerBacklinksHealthRoute(app, options.config);
  registerBacklinksContextRoute(app, {
    module: options.dependencies.module,
  });
  registerBacklinksContactsRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.contactCommands,
  });
  registerBacklinksRecommendationsRoute(app, {
    module: options.dependencies.module,
  });
  registerBacklinksOpportunitiesRoutes(app, {
    module: options.dependencies.module,
  });
  registerBacklinksOpportunityCommandsRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.opportunityCommands,
  });
  registerBacklinksPlacementCandidateRoutes(app, {
    module: options.dependencies.module,
    command: options.dependencies.placementCandidateCommand,
  });
  registerBacklinksPlacementReviewRoutes(app, {
    module: options.dependencies.module,
    command: options.dependencies.placementReviewCommand,
  });
  registerBacklinksLinksRoutes(app, {
    module: options.dependencies.module,
    reverifyCommand: options.dependencies.placementReverifyCommand,
  });
  registerBacklinksRecommendationCommandsRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.recommendationCommands,
  });
  registerBacklinksAssessmentRoute(app, {
    module: options.dependencies.module,
  });
  registerBacklinksDraftRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.draftCommands,
  });
  registerBacklinksDraftEditingRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.draftEditingCommands,
  });
  registerBacklinksSendIntentRoute(app, {
    module: options.dependencies.module,
    commands: options.dependencies.sendIntentCommands,
  });
  registerBacklinksGmailConnectionRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.gmailConnectionCommands,
    query: options.dependencies.gmailConnectionQuery,
  });
  registerBacklinksReplyMatchRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.replyMatchCommands,
  });
  registerBacklinksReplyMailRoutes(app, {
    module: options.dependencies.module,
  });
  registerBacklinksGmailMailPushRoute(app, {
    webhook: options.dependencies.gmailPushWebhook
      ?? createDisabledGmailPushWebhook(),
  });
  registerBacklinksSummaryRoute(app, {
    module: options.dependencies.module,
  });
  return app;
}

export async function startBacklinksPrivateApi(
  app: FastifyInstance,
  options: StartBacklinksPrivateApiOptions,
): Promise<StartedBacklinksPrivateApi> {
  const host = options.host ?? "127.0.0.1";
  assertPrivateBind(host, options.allowNonLoopback ?? false);
  const address = await app.listen({ host, port: options.port });
  let stopped = false;

  return Object.freeze({
    address,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await app.close();
    },
  });
}
