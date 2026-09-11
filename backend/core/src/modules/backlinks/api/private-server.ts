import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createContactCommands } from "../application/commands/contacts.command.js";
import type { createContactEnrichmentCommands } from "../application/commands/contact-enrichment.command.js";
import type {
  createDraftCommands,
  createDraftEditingCommands,
} from "../application/commands/draft.command.js";
import type { createGmailConnectionCommands } from "../application/commands/gmail-connection.command.js";
import type { createCooperationPathOpportunityCommands } from "../application/commands/cooperation-path-opportunities.command.js";
import type { createOpportunityCommands } from "../application/commands/opportunities.command.js";
import type { createPlacementCandidateCommand } from "../application/commands/placement-candidate.command.js";
import type { createPlacementReverifyCommand } from "../application/commands/placement-reverify.command.js";
import type { createPlacementReviewCommand } from "../application/commands/placement-review.command.js";
import type { RecommendationPoolV2GenerationLifecycleCommands } from "../application/services/recommendation-pool-v2-generation-launcher.service.js";
import type { RecommendationUserReleaseCommands } from "../application/commands/recommendation-user-release.command.js";
import type { ProjectContextProjectionCommand } from "../application/commands/project-context-projection.command.js";
import type { createReplyMatchCommands } from "../application/commands/reply-match.command.js";
import type { createSendIntentCommands } from "../application/commands/send-intent.command.js";
import type { createBacklinkProfileService } from "../application/services/backlink-profile.service.js";
import type { NegotiationFactsService } from "../application/services/negotiation-facts.service.js";
import type { AssessmentQuery } from "../application/queries/assessment.query.js";
import type { DraftQuery } from "../application/queries/draft.query.js";
import type { createGmailConnectionQuery } from "../application/queries/gmail-connection.query.js";
import type { OpportunitiesQuery } from "../application/queries/opportunities.query.js";
import type { MetricDashboardQuery } from "../application/queries/metric-dashboard.query.js";
import type { PlacementLinksQuery } from "../application/queries/placement-links.query.js";
import { createRecommendationFeedQuery } from "../application/queries/recommendation-feed.query.js";
import type { RecommendationsQuery } from "../application/queries/recommendations.query.js";
import type { ResourceLibraryQuery } from "../application/queries/resource-library.query.js";
import type { ReportOverviewQuery } from "../application/queries/report-overview.query.js";
import type { ReplyMailQuery } from "../application/queries/reply-mail.query.js";
import type { SendIntentQuery } from "../application/queries/send-intent.query.js";
import type { SendIntentListQuery } from "../application/queries/send-intent.query.js";
import type { SummaryQuery } from "../application/queries/summary.query.js";
import type { ReportExportWorkflow } from "../application/workflows/report-export.workflow.js";
import type { GmailPollingSyncCommands } from "../application/workflows/gmail-polling-sync-workflow.js";
import {
  createDisabledGmailPushWebhook,
  type GmailPushWebhookHandler,
} from "../application/workflows/mail-push-webhook.js";
import type { BacklinksConfig } from "../config/index.js";
import type { RecommendationFeedObserver } from "../db/repositories/recommendation-pool-v2-timing.repository.js";
import type { RecommendationFeedRepository } from "../application/queries/recommendation-feed.query.js";
import type { BacklinksApiRuntimeHealth } from "../runtime/runtime-health.js";
import { registerBacklinksAssessmentRoute } from "./assessment.route.js";
import { registerBacklinkProfileRoutes } from "./backlink-profile.route.js";
import { registerBacklinksContactsRoutes } from "./contacts.route.js";
import { registerBacklinksContactEnrichmentRoutes } from "./contact-enrichment.route.js";
import { registerBacklinksContextRoute } from "./context.route.js";
import { registerCooperationPathOpportunityCommandsRoutes } from "./cooperation-path-opportunity-commands.route.js";
import {
  registerBacklinksDraftEditingRoutes,
  registerBacklinksDraftRoutes,
} from "./draft.route.js";
import { registerBacklinksGmailConnectionRoutes } from "./gmail-connection.route.js";
import { registerBacklinksGmailMailPushRoute } from "./gmail-mail-push.route.js";
import { registerBacklinksHealthRoute } from "./health.route.js";
import { registerBacklinksRequestLoggingHook } from "./hooks/request-logging.hook.js";
import { registerBacklinksLinksRoutes } from "./links.route.js";
import { registerBacklinksMetricDashboardRoute } from "./metrics/metric-dashboard.route.js";
import { registerBacklinksNegotiationFactsRoutes } from "./negotiation-facts.route.js";
import { registerBacklinksOpenApi } from "./openapi.js";
import { registerBacklinksOpportunitiesRoutes } from "./opportunities.route.js";
import { registerBacklinksOpportunityCommandsRoutes } from "./opportunity-commands.route.js";
import { registerBacklinksPlacementCandidateRoutes } from "./placement-candidates.route.js";
import { registerBacklinksPlacementReviewRoutes } from "./placement-review.route.js";
import { registerProjectContextProjectionRoute } from "./project-context-projection.route.js";
import { registerBacklinksPlatformContextConsumer } from "./platform-request-context.js";
import { registerRecommendationFeedRoutes } from "./recommendation-feed.route.js";
import { registerBacklinksRecommendationSeedRoutes } from "./recommendation-seeds.route.js";
import { registerBacklinksRecommendationUserReleaseRoutes } from "./recommendation-user-release.route.js";
import { registerBacklinksRecommendationsRoute } from "./recommendations.route.js";
import { registerBacklinksResourceLibraryRoute } from "./resource-library.route.js";
import { registerBacklinksReplyMailRoutes } from "./reply-mail.route.js";
import { registerBacklinksReplyMatchRoutes } from "./reply-match.route.js";
import { registerBacklinksReportExportRoutes } from "./reports/report-export.route.js";
import { registerBacklinksReportOverviewRoute } from "./reports/report-overview.route.js";
import { registerBacklinksSendIntentRoute } from "./send-intent.route.js";
import { registerBacklinksSendIntentListRoute } from "./send-intent.route.js";
import {
  registerBacklinksSettingsGovernanceRoutes,
  type BacklinksSettingsGovernanceService,
} from "./settings/settings-governance.route.js";
import { registerBacklinksSummaryRoute } from "./summary.route.js";

type BacklinksApiQueries = AssessmentQuery &
  DraftQuery &
  OpportunitiesQuery &
  PlacementLinksQuery &
  RecommendationsQuery &
  ResourceLibraryQuery &
  ReplyMailQuery &
  SendIntentListQuery &
  SendIntentQuery &
  SummaryQuery;
type ContactCommands = ReturnType<typeof createContactCommands>;
type ContactEnrichmentCommands = ReturnType<
  typeof createContactEnrichmentCommands
>;
type DraftCommands = ReturnType<typeof createDraftCommands>;
type DraftEditingCommands = ReturnType<typeof createDraftEditingCommands>;
type GmailConnectionCommands = ReturnType<typeof createGmailConnectionCommands>;
type GmailConnectionQuery = ReturnType<typeof createGmailConnectionQuery>;
type CooperationPathOpportunityCommands = ReturnType<
  typeof createCooperationPathOpportunityCommands
>;
type OpportunityCommands = ReturnType<typeof createOpportunityCommands>;
type PlacementCandidateCommand = ReturnType<
  typeof createPlacementCandidateCommand
>;
type PlacementReverifyCommand = ReturnType<
  typeof createPlacementReverifyCommand
>;
type PlacementReviewCommand = ReturnType<typeof createPlacementReviewCommand>;
type ReplyMatchCommands = ReturnType<typeof createReplyMatchCommands>;
type SendIntentCommands = ReturnType<typeof createSendIntentCommands>;
type BacklinkProfileService = ReturnType<typeof createBacklinkProfileService>;

export type BacklinksPrivateApiDependencies = Readonly<{
  module: BacklinksModule<BacklinksApiQueries>;
  contactCommands: ContactCommands;
  contactEnrichmentCommands: ContactEnrichmentCommands;
  draftCommands: DraftCommands;
  draftEditingCommands: DraftEditingCommands;
  gmailConnectionCommands: GmailConnectionCommands;
  gmailConnectionQuery: GmailConnectionQuery;
  gmailPollingSyncCommands: GmailPollingSyncCommands;
  cooperationPathOpportunityCommands?: CooperationPathOpportunityCommands;
  opportunityCommands: OpportunityCommands;
  placementCandidateCommand: PlacementCandidateCommand;
  placementReverifyCommand: PlacementReverifyCommand;
  placementReviewCommand: PlacementReviewCommand;
  recommendationFeedRepository?: RecommendationFeedRepository;
  recommendationFeedObserver?: RecommendationFeedObserver;
  recommendationSeedCommands?: RecommendationPoolV2GenerationLifecycleCommands;
  recommendationUserReleaseCommands?: RecommendationUserReleaseCommands;
  metricDashboardQuery: MetricDashboardQuery;
  reportOverviewQuery: ReportOverviewQuery;
  reportExportWorkflow: ReportExportWorkflow;
  replyMatchCommands: ReplyMatchCommands;
  negotiationFactsService?: NegotiationFactsService;
  sendIntentCommands: SendIntentCommands;
  settingsGovernanceService: BacklinksSettingsGovernanceService;
  backlinkProfileService: BacklinkProfileService;
  projectContextProjectionCommand?: ProjectContextProjectionCommand;
  gmailPushWebhook?: GmailPushWebhookHandler;
}>;

export type CreateBacklinksPrivateApiOptions = Readonly<{
  config: BacklinksConfig;
  platformContextSigningKey: string | Buffer;
  dependencies: BacklinksPrivateApiDependencies;
  readiness?: () => Promise<void>;
  buildIdentity?: Readonly<{
    buildId: string;
    sourceFingerprint: string;
    artifactFingerprint: string;
  }>;
  runtimeHealth?: BacklinksApiRuntimeHealth;
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

function assertPrivateBind(host: string, allowNonLoopback: boolean): void {
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
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: options.config.BACKLINK_API_BODY_LIMIT,
    requestTimeout: options.config.BACKLINK_API_REQUEST_TIMEOUT_MS,
  });
  await registerBacklinksOpenApi(app);
  registerBacklinksRequestLoggingHook(app);
  registerBacklinksPlatformContextConsumer(app, {
    signingKey: options.platformContextSigningKey,
  });
  registerBacklinksHealthRoute(app, options.config, options.runtimeHealth);
  app.get(
    "/ready",
    {
      schema: {
        hide: true,
      },
    },
    async (_request, reply) => {
      try {
        await options.readiness?.();
        return {
          status: "ok" as const,
          ...(options.buildIdentity === undefined
            ? {}
            : { build: options.buildIdentity }),
        };
      } catch {
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );
  registerBacklinksContextRoute(app, {
    module: options.dependencies.module,
  });
  if (options.dependencies.projectContextProjectionCommand !== undefined) {
    registerProjectContextProjectionRoute(
      app,
      options.dependencies.projectContextProjectionCommand,
    );
  }
  registerBacklinksContactsRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.contactCommands,
  });
  registerBacklinksContactEnrichmentRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.contactEnrichmentCommands,
  });
  registerBacklinksRecommendationsRoute(app, {
    module: options.dependencies.module,
    runningBuildId: options.buildIdentity?.buildId ?? "unknown",
  });
  registerBacklinksResourceLibraryRoute(app, {
    module: options.dependencies.module,
  });
  registerBacklinksOpportunitiesRoutes(app, {
    module: options.dependencies.module,
  });
  registerBacklinksOpportunityCommandsRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.opportunityCommands,
  });
  if (options.dependencies.cooperationPathOpportunityCommands !== undefined) {
    registerCooperationPathOpportunityCommandsRoutes(app, {
      module: options.dependencies.module,
      commands: options.dependencies.cooperationPathOpportunityCommands,
    });
  }
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
  registerBacklinkProfileRoutes(app, {
    module: options.dependencies.module,
    service: options.dependencies.backlinkProfileService,
  });
  registerBacklinksMetricDashboardRoute(app, {
    projectContext: options.dependencies.module.projectContext,
    query: options.dependencies.metricDashboardQuery,
  });
  registerBacklinksReportOverviewRoute(app, {
    projectContext: options.dependencies.module.projectContext,
    query: options.dependencies.reportOverviewQuery,
  });
  registerBacklinksReportExportRoutes(app, {
    projectContext: options.dependencies.module.projectContext,
    workflow: options.dependencies.reportExportWorkflow,
  });
  registerBacklinksSettingsGovernanceRoutes(app, {
    projectContext: options.dependencies.module.projectContext,
    service: options.dependencies.settingsGovernanceService,
  });
  if (options.dependencies.recommendationFeedRepository !== undefined) {
    registerRecommendationFeedRoutes(app, {
      module: options.dependencies.module,
      observe: options.dependencies.recommendationFeedObserver,
      query: createRecommendationFeedQuery(
        options.dependencies.recommendationFeedRepository,
        { cursorSigningKey: options.platformContextSigningKey },
      ),
    });
  }
  if (options.dependencies.recommendationSeedCommands !== undefined) {
    registerBacklinksRecommendationSeedRoutes(app, {
      module: options.dependencies.module,
      commands: options.dependencies.recommendationSeedCommands,
    });
  }
  if (options.dependencies.recommendationUserReleaseCommands !== undefined) {
    registerBacklinksRecommendationUserReleaseRoutes(app, {
      module: options.dependencies.module,
      commands: options.dependencies.recommendationUserReleaseCommands,
    });
  }
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
  registerBacklinksSendIntentListRoute(app, {
    module: options.dependencies.module,
  });
  registerBacklinksGmailConnectionRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.gmailConnectionCommands,
    query: options.dependencies.gmailConnectionQuery,
    syncCommands: options.dependencies.gmailPollingSyncCommands,
  });
  registerBacklinksReplyMatchRoutes(app, {
    module: options.dependencies.module,
    commands: options.dependencies.replyMatchCommands,
  });
  if (options.dependencies.negotiationFactsService !== undefined) {
    registerBacklinksNegotiationFactsRoutes(app, {
      module: options.dependencies.module,
      service: options.dependencies.negotiationFactsService,
    });
  }
  registerBacklinksReplyMailRoutes(app, {
    module: options.dependencies.module,
  });
  registerBacklinksGmailMailPushRoute(app, {
    webhook:
      options.dependencies.gmailPushWebhook ?? createDisabledGmailPushWebhook(),
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
