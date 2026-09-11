import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BacklinksProductionRuntimeModule,
  BacklinksRuntimeFactoryContext,
} from "../../../index.js";
import { createBacklinksModule } from "../application/backlinks.module.js";
import { createContactCommands } from "../application/commands/contacts.command.js";
import {
  createContactEnrichmentCommands,
  ensureReadyContactEnrichmentJobs,
} from "../application/commands/contact-enrichment.command.js";
import {
  createDraftCommands,
  createDraftEditingCommands,
} from "../application/commands/draft.command.js";
import type { createGmailConnectionCommands } from "../application/commands/gmail-connection.command.js";
import { createGmailConnectionCommands as createProductionGmailConnectionCommands } from "../application/commands/gmail-connection.command.js";
import { createCooperationPathOpportunityCommands } from "../application/commands/cooperation-path-opportunities.command.js";
import { createOpportunityCommands } from "../application/commands/opportunities.command.js";
import {
  createPlacementCandidateCommand,
  type PlacementCandidateRepository,
} from "../application/commands/placement-candidate.command.js";
import { createPlacementReverifyCommand } from "../application/commands/placement-reverify.command.js";
import { createPlacementReviewCommand } from "../application/commands/placement-review.command.js";
import { createRecommendationSeedCommands } from "../application/commands/recommendation-seeds.command.js";
import { createRecommendationUserReleaseCommands } from "../application/commands/recommendation-user-release.command.js";
import { createProjectContextProjectionCommand } from "../application/commands/project-context-projection.command.js";
import { createReplyMatchCommands } from "../application/commands/reply-match.command.js";
import type { createSendIntentCommands } from "../application/commands/send-intent.command.js";
import {
  createAssessmentQuery,
  type AssessmentQuery,
} from "../application/queries/assessment.query.js";
import {
  createDraftQuery,
  type DraftQuery,
} from "../application/queries/draft.query.js";
import { createGmailConnectionQuery } from "../application/queries/gmail-connection.query.js";
import {
  createMetricDashboardQuery,
  type MetricDashboardQuery,
} from "../application/queries/metric-dashboard.query.js";
import {
  createOpportunitiesQuery,
  type OpportunitiesQuery,
} from "../application/queries/opportunities.query.js";
import {
  createPlacementLinksQuery,
  type PlacementLinksQuery,
} from "../application/queries/placement-links.query.js";
import {
  createRecommendationsQuery,
  type RecommendationsQuery,
} from "../application/queries/recommendations.query.js";
import {
  createResourceLibraryQuery,
  type ResourceLibraryQuery,
} from "../application/queries/resource-library.query.js";
import {
  createReplyMailQuery,
  type ReplyMailQuery,
} from "../application/queries/reply-mail.query.js";
import {
  createSendIntentQuery,
  type SendIntentQuery,
  type SendIntentWorkerMode,
} from "../application/queries/send-intent.query.js";
import type { SendIntentListQuery } from "../application/queries/send-intent.query.js";
import {
  createReportOverviewQuery,
  type ReportOverviewQuery,
} from "../application/queries/report-overview.query.js";
import type { SummaryQuery } from "../application/queries/summary.query.js";
import {
  createDraftEditingRepository,
  createDraftGenerationRepository,
  type DraftGenerationRepository,
} from "../application/repositories/draft-generation.repository.js";
import { createInventoryMonitorRepository } from "../application/repositories/inventory-monitor.repository.js";
import { createPlacementMonitorRepository } from "../application/repositories/placement-monitor.repository.js";
import { createPlacementReviewRepository } from "../application/repositories/placement-review.repository.js";
import { createPlacementInitialValidationRepository } from "../application/repositories/placement-validation.repository.js";
import { createPlacementStaticMonitorActivity } from "../application/activities/placement-static-monitor.activity.js";
import { PostgresqlReplyMatchRepository } from "../application/services/reply-match.repository.js";
import { createPostgresqlNegotiationFactsService } from "../application/services/negotiation-facts.service.js";
import {
  createBacklinkProfileService,
  createBacklinkProfileStore,
} from "../application/services/backlink-profile.service.js";
import { SecretBackedGmailConnectionRepository } from "../application/services/gmail-connection-secret.repository.js";
import { runProjectScopedLane } from "../application/services/project-scope-scheduler.js";
import { GmailConnectionDisconnectWorkflow } from "../application/workflows/gmail-connection-disconnect.workflow.js";
import {
  createGmailPollingSyncCapabilityPausedResult,
  type GmailPollingSyncWorkflowInput,
} from "../application/workflows/gmail-polling-sync-workflow.js";
import { runDraftGenerationWorkflow } from "../application/workflows/draft-generation-workflow.js";
import {
  createReportExportWorkflow,
  type ReportExportRecord,
  type ReportExportRepository,
  type ReportExportScope,
} from "../application/workflows/report-export.workflow.js";
import type {
  PlacementMonitoringInitializationResult,
  PlacementMonitoringInitializationWorkflowInput,
} from "../application/workflows/placement-monitoring-initialization.workflow.js";
import type { BacklinksPrivateApiDependencies } from "../api/private-server.js";
import { verifiedPlatformContextForActor } from "../api/platform-request-context.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  PostgresqlGmailConnectionRefreshLock,
  PostgresqlGmailConnectionRepository,
} from "../db/repositories/gmail-connection.repository.js";
import { PostgresqlOAuthAttemptRepository } from "../db/repositories/oauth-attempt.repository.js";
import {
  createInventoryMonitoringScheduleRepository,
  createMonitoringScheduleRepository,
} from "../db/repositories/monitoring-schedule.repository.js";
import { createOpportunityRepository } from "../db/repositories/opportunity.repository.js";
import { createCooperationPathOpportunityRepository } from "../db/repositories/cooperation-path-opportunity.repository.js";
import { createProjectContextSnapshotRepository } from "../db/repositories/project-context-snapshot.repository.js";
import { createRecommendationSeedRepository } from "../db/repositories/recommendation-seed.repository.js";
import { createRecommendationPoolV2GenerationLaunchRepository } from "../db/repositories/recommendation-pool-v2-generation-launch.repository.js";
import { createScopedRecommendationPoolV2TimingRecorder, createRecommendationFeedObserver } from "../db/repositories/recommendation-pool-v2-timing.repository.js";
import { createRecommendationFeedRepository } from "../db/repositories/recommendation-feed.repository.js";
import { createRecommendationUserReleaseRepository } from "../db/repositories/recommendation-user-release.repository.js";
import {
  createOutboxRelayRepository,
  createScopedOutboxRelayRepository,
} from "../db/repositories/outbox.repository.js";
import { createPostgresqlProjectScopeProvider } from "../db/repositories/project-scope.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTenantContext,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";
import type { ResolvedProjectContext } from "../ports/project-context.port.js";
import type { ActiveProjectScope } from "../ports/project-scope-provider.port.js";
import {
  createBacklinkProjectAnalysisActivities,
  createProjectAnalysisJobWriter,
} from "../activities/backlink-project-analysis.activity.js";
import { createContactEnrichmentActivity } from "../activities/contact-enrichment.activity.js";
import {
  createRecommendationPoolV2Activities,
  createRecommendationPoolV2Phase4Activities,
  recoverRecommendationPoolV2CanonicalBatchPreparation,
} from "../activities/recommendation-pool-v2.activity.js";
import { createSharedBrowserWorkerAdapter } from "../adapters/browser/shared-browser-worker.adapter.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  createBacklinkOutboxRelay,
  createContactEnrichmentOutboxRelay,
  createPlacementMonitoringRequestedOutboxRelay,
  createTemporalBacklinkProjectAnalysisStarter,
  createTemporalContactEnrichmentConsumer,
  createTemporalPlacementInitialValidationStarter,
  createTemporalPlacementMonitoringInitializationConsumer,
  createTemporalPlacementMonitoringStarter,
} from "../workflows/outbox-relay.js";
import {
  backlinksRuntimeContract,
} from "../workflows/namespaces.js";
import { createTemporalDraftGenerationScheduler } from "../workflows/draft-generation.starter.js";
import { createTemporalBacklinkProfileSyncScheduler } from "../workflows/backlink-profile-sync.starter.js";
import { createTemporalRecommendationPoolV2Starter } from "../workflows/recommendation-pool-v2.starter.js";
import { createPlacementTemporalActivities } from "../workflows/placement.activities.js";
import { GoogleAuthClientAdapter } from "../adapters/gmail/auth-client.js";
import { GoogleAuthLibraryClient } from "../adapters/gmail/google-auth-library-client.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { SecretStoreClientAdapter } from "../adapters/security/secret-store-client.js";
import { OAuthAttemptService } from "../domain/sending/oauth-attempt.js";
import { GoogleAuthError } from "../ports/google-auth.port.js";
import { secretKinds } from "../ports/secret-store.port.js";
import { readBacklinksLiveCapabilities } from "./live-capabilities.js";
import { createBacklinksProvidersHealth } from "./runtime-health.js";
import {
  combineProjectTaskHealth,
  createGlobalProjectAnalysisRecovery,
  createScopedProjectAnalysisRecovery,
  type ProjectTaskHealth,
} from "./project-analysis-recovery.js";
import {
  createLocalProductAiRuntime,
  readLocalProductAiConfiguration,
} from "./local-product-ai-runtime.js";
import {
  assertLocalProductDataForSeoCredentialReady,
  createLocalProductDataForSeoRuntime,
  readLocalProductDataForSeoConfiguration,
} from "./local-product-dataforseo-runtime.js";
import { createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor } from "./recommendation-pool-v2-dataforseo-executor.js";
import { createRecommendationHybridSupplyRuntime } from "./recommendation-hybrid-supply-runtime.js";
import {
  createRecommendationPoolV2GenerationLauncher,
  type RecommendationPoolV2GenerationLifecycleCommands,
} from "../application/services/recommendation-pool-v2-generation-launcher.service.js";
import {
  createLocalProductBacklinkProfileRuntime,
  markBacklinkProfileInputRequired,
} from "./local-product-backlink-profile-runtime.js";
import {
  createLocalProductGmailSendRuntime,
  createLocalProductSendIntentCommands,
} from "./local-product-gmail-runtime.js";
import {
  createLocalProductGmailPollingSyncCommands,
  createLocalProductGmailPollingSyncRuntime,
} from "./local-product-gmail-sync-runtime.js";
import { createLocalProductReplyMailContentReader } from "./local-product-mail-store.js";

export const gmailTokenHealthMaximumRetryDelaySeconds = 3_600;

export const calculateGmailTokenHealthRetryDelaySeconds = (
  consecutiveFailures: number,
): number =>
  Math.min(
    gmailTokenHealthMaximumRetryDelaySeconds,
    60 * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 16),
  );

type ContactCommands = ReturnType<typeof createContactCommands>;
type ContactEnrichmentCommands = ReturnType<
  typeof createContactEnrichmentCommands
>;
type DraftCommands = ReturnType<typeof createDraftCommands>;
type DraftEditingCommands = ReturnType<typeof createDraftEditingCommands>;
type GmailConnectionCommands = ReturnType<typeof createGmailConnectionCommands>;
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
type SendIntentCommands = ReturnType<typeof createSendIntentCommands>;
type BacklinkProfileStore = ReturnType<typeof createBacklinkProfileStore>;
type QueryFactory<T extends object> = (client: BacklinkTransactionClient) => T;

function providerDisabled(capability: string): never {
  throw new BacklinkError({
    code: backlinkErrorCodes.internal,
    message: `${capability} is disabled for this runtime.`,
  });
}

function tenantPool(
  context: BacklinksRuntimeFactoryContext,
): BacklinkTenantPool {
  return context.pool as unknown as BacklinkTenantPool;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function tenantScopeFrom(value: unknown): BacklinkTenantContext {
  if (!isRecord(value)) {
    throw new TypeError("A tenant-scoped runtime operation requires input.");
  }
  if (isRecord(value.context)) {
    return tenantScopeFrom(value.context);
  }
  if (isRecord(value.scope)) {
    return tenantScopeFrom(value.scope);
  }
  if (isRecord(value.tenant) && isRecord(value.project)) {
    return {
      organizationId: String(value.tenant.organizationId),
      workspaceId: String(value.tenant.workspaceId),
      websiteProjectId: String(value.project.websiteProjectId),
    };
  }
  if (
    typeof value.organizationId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.websiteProjectId === "string"
  ) {
    return {
      organizationId: value.organizationId,
      workspaceId: value.workspaceId,
      websiteProjectId: value.websiteProjectId,
    };
  }
  throw new TypeError("A tenant-scoped runtime operation has invalid scope.");
}

async function listContactEnrichmentRecoveryScopes(
  pool: BacklinksRuntimeFactoryContext["pool"],
  limit: number,
): Promise<readonly BacklinkTenantContext[]> {
  const result = await pool.query(
    `SELECT scope.organization_id "organizationId",
            scope.workspace_id "workspaceId",
            scope.website_project_id "websiteProjectId"
       FROM backlinks.backlink_list_contact_enrichment_recovery_scopes($1)
         AS scope
      ORDER BY scope.organization_id,scope.workspace_id,scope.website_project_id
      LIMIT $1`,
    [limit],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        organizationId: String(row.organizationId),
        workspaceId: String(row.workspaceId),
        websiteProjectId: String(row.websiteProjectId),
      }),
    ),
  );
}

function localProductWorkerAuthority(): Readonly<{
  organizationId: string;
  workspaceId: string;
  actorId: string;
}> | null {
  if (process.env.BACKLINKS_RUNTIME_MODE !== "LOCAL_PRODUCT") return null;
  const organizationId = process.env.LOCAL_PRODUCT_ORGANIZATION_ID;
  const workspaceId = process.env.LOCAL_PRODUCT_WORKSPACE_ID;
  const actorId = process.env.LOCAL_PRODUCT_USER_ID;
  if (
    [organizationId, workspaceId, actorId].some(
      (value) => value === undefined || value.trim().length === 0,
    )
  ) {
    throw new Error("BACKLINKS_LOCAL_PRODUCT_WORKER_AUTHORITY_MISSING");
  }
  return {
    organizationId: organizationId as string,
    workspaceId: workspaceId as string,
    actorId: actorId as string,
  };
}

function scopedMethod<T extends object, K extends keyof T>(
  pool: BacklinkTenantPool,
  factory: QueryFactory<T>,
  method: K,
): T[K] {
  return (async (...args: readonly unknown[]) => {
    const scope = tenantScopeFrom(args[0]);
    return withBacklinkTenantTransaction(pool, scope, async (transaction) => {
      const target = factory(transaction);
      const operation = target[method];
      if (typeof operation !== "function") {
        throw new TypeError(`Runtime operation ${String(method)} is invalid.`);
      }
      return Reflect.apply(operation, target, args);
    });
  }) as T[K];
}

function createScopedDraftGenerationRepository(
  pool: BacklinkTenantPool,
): DraftGenerationRepository {
  const scoped = <T>(
    input: BacklinkTenantContext,
    operation: (repository: DraftGenerationRepository) => Promise<T>,
  ): Promise<T> =>
    withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
      operation(createDraftGenerationRepository(client)),
    );
  return Object.freeze({
    prepareEvidenceSnapshot: (input) =>
      scoped(input, (repository) => repository.prepareEvidenceSnapshot(input)),
    createJob: (input) =>
      scoped(input, (repository) => repository.createJob(input)),
    claimJob: (input) =>
      scoped(input, (repository) => repository.claimJob(input)),
    loadPromptContext: (input) =>
      scoped(input, (repository) => repository.loadPromptContext(input)),
    completeJob: (input) =>
      scoped(input, (repository) => repository.completeJob(input)),
    failJob: (input) =>
      scoped(input, (repository) => repository.failJob(input)),
    scheduleRetry: (input) =>
      scoped(input, (repository) => repository.scheduleRetry(input)),
    getJob: (input) => scoped(input, (repository) => repository.getJob(input)),
    findLatestJob: (input) =>
      scoped(input, (repository) => repository.findLatestJob(input)),
    getDraft: (input) =>
      scoped(input, (repository) => repository.getDraft(input)),
  });
}

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha256").update(value, "utf8").digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function automaticProfileSyncEnabled(mode: string | undefined): boolean {
  if (mode === undefined || mode === "automatic") return true;
  if (mode === "manual") return false;
  throw new Error("BACKLINKS_PROFILE_SYNC_MODE_INVALID");
}

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`BACKLINKS_RUNTIME_INTEGER_INVALID:${name}`);
  }
  return value;
}

function createScopedPlacementInitialValidationRepository(
  pool: BacklinkTenantPool,
): ReturnType<typeof createPlacementInitialValidationRepository> {
  return {
    getCandidate: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createPlacementInitialValidationRepository(client).getCandidate(input),
      ),
    record: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createPlacementInitialValidationRepository(client).record(input),
      ),
  };
}

function createScopedPlacementMonitorRepository(
  pool: BacklinkTenantPool,
): ReturnType<typeof createPlacementMonitorRepository> {
  return {
    prepare: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createPlacementMonitorRepository(client).prepare(input),
      ),
    scheduleRetry: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createPlacementMonitorRepository(client).scheduleRetry(input),
      ),
    complete: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createPlacementMonitorRepository(client).complete(input),
      ),
  };
}

function createScopedInventoryMonitorRepository(
  pool: BacklinkTenantPool,
): ReturnType<typeof createInventoryMonitorRepository> {
  return {
    prepare: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createInventoryMonitorRepository(client).prepare(input),
      ),
    scheduleRetry: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createInventoryMonitorRepository(client).scheduleRetry(input),
      ),
    complete: (input) =>
      withBacklinkTenantTransaction(pool, tenantScopeFrom(input), (client) =>
        createInventoryMonitorRepository(client).complete(input),
      ),
  };
}

function createProjectContextPort(pool: BacklinkTenantPool) {
  return {
    async resolve(
      input: Readonly<{
        actor: ResolvedProjectContext["actor"];
        websiteProjectKey: string;
      }>,
    ): Promise<ResolvedProjectContext> {
      const platform = verifiedPlatformContextForActor(input.actor);
      if (
        platform.project === null ||
        platform.project.websiteProjectKey !== input.websiteProjectKey
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied,
          message: "The platform context is not valid for this project.",
        });
      }
      const scope = {
        organizationId: platform.tenant.organizationId,
        workspaceId: platform.tenant.workspaceId,
        websiteProjectId: platform.project.websiteProjectId,
      };
      const snapshot = await withBacklinkTenantTransaction(
        pool,
        scope,
        (transaction) =>
          createProjectContextSnapshotRepository(transaction).findLatest(scope),
      );
      if (snapshot === null || snapshot.projectStatus !== "ACTIVE") {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Website Project is not active in Backlinks Core.",
        });
      }
      return Object.freeze({
        actor: input.actor,
        tenant: createTenantContext({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
        }),
        project: createProjectContext({
          websiteProjectId: scope.websiteProjectId,
          canonicalDomain: snapshot.canonicalDomain,
          locale: snapshot.locale,
          countryCode: snapshot.countryCode,
          profileVersionId: snapshot.profileVersionId,
          promotionTargetVersionId: snapshot.promotionTargetVersionId,
        }),
      });
    },
  };
}

async function createWorkerProjectContext(
  pool: BacklinkTenantPool,
  scope: BacklinkTenantContext,
  actorId: string,
): Promise<ResolvedProjectContext | null> {
  const snapshot = await withBacklinkTenantTransaction(
    pool,
    scope,
    (transaction) =>
      createProjectContextSnapshotRepository(transaction).findLatest(scope),
  );
  if (snapshot === null || snapshot.projectStatus !== "ACTIVE") {
    return null;
  }
  return Object.freeze({
    actor: createActorContext({
      userId: actorId,
      sessionId: `gmail-token-health:${scope.websiteProjectId}`,
      roles: ["member"],
    }),
    tenant: createTenantContext({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    }),
    project: createProjectContext({
      websiteProjectId: scope.websiteProjectId,
      canonicalDomain: snapshot.canonicalDomain,
      locale: snapshot.locale,
      countryCode: snapshot.countryCode,
      profileVersionId: snapshot.profileVersionId,
      promotionTargetVersionId: snapshot.promotionTargetVersionId,
    }),
  });
}

function createPlacementCandidateRepository(
  client: BacklinkTransactionClient,
): PlacementCandidateRepository {
  return {
    async create(input) {
      const result = await client.query(
        `WITH guard AS (
           SELECT pg_advisory_xact_lock(hashtextextended(
             $2::uuid::text||':'||$22||':placement.candidate.create',0
           ))
         ), prior AS (
           SELECT record.request_hash AS "requestHash",
                  record.response_body AS "responseBody"
             FROM guard
             CROSS JOIN LATERAL (
               SELECT *
                 FROM backlink_idempotency_records
                WHERE workspace_id=$2
                  AND idempotency_key=$22
                  AND command_type='placement.candidate.create'
             ) record
         ), matched_opportunity AS (
           SELECT opportunity.id
             FROM guard
             JOIN backlink_opportunities opportunity
               ON opportunity.organization_id=$1
              AND opportunity.workspace_id=$2
              AND opportunity.website_project_id=$3
              AND opportunity.id=$25::uuid
            WHERE $25::uuid IS NOT NULL
         ), created AS (
           INSERT INTO backlink_placement_candidates (
             id,organization_id,workspace_id,website_project_id,
             opportunity_id,
             reply_id,planned_placement_id,
             source_type,source_external_id,source_page_url,
             normalized_source_url,normalized_source_url_hash,
             target_url,normalized_target_url,normalized_target_url_hash,
             url_normalization_version,status,match_status,
             initial_validation_status,discovery_evidence_snapshot,
             discovery_evidence_hash,evidence_contract_version,
             evidence_schema_version,created_by,updated_by
           )
           SELECT
             $5,$1,$2,$3,$25,$26,$27,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18::jsonb,$19,$20,$21,$4,$4
             FROM guard
            WHERE NOT EXISTS (SELECT 1 FROM prior)
              AND (
                $25::uuid IS NULL
                OR EXISTS (SELECT 1 FROM matched_opportunity)
              )
              AND (
                $26::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM backlink_inbound_messages inbound
                    JOIN backlink_reply_match_candidates assignment
                      ON (
                        assignment.organization_id,
                        assignment.workspace_id,
                        assignment.website_project_id,
                        assignment.inbound_message_id,
                        assignment.opportunity_id
                      )=(
                        inbound.organization_id,
                        inbound.workspace_id,
                        inbound.website_project_id,
                        inbound.id,
                        $25::uuid
                      )
                   WHERE (
                     inbound.organization_id,
                     inbound.workspace_id,
                     inbound.website_project_id,
                     inbound.id
                   )=($1,$2,$3,$26::uuid)
                     AND inbound.match_status='MATCH_CONFIRMED'
                     AND assignment.requires_manual_confirmation=false
                )
              )
           RETURNING id,opportunity_id,status,match_status,
                     initial_validation_status,version,
                     reply_id,planned_placement_id
         ), completed AS (
           INSERT INTO backlink_idempotency_records (
             id,organization_id,workspace_id,website_project_id,
             idempotency_key,command_type,request_hash,response_status,
             response_body,response_schema_version,completed_at,expires_at,
             created_by,updated_by
           )
           SELECT
             $23,$1,$2,$3,$22,'placement.candidate.create',$24,201,
             jsonb_build_object(
               'candidateId',created.id,
               'opportunityId',created.opportunity_id,
               'replyId',created.reply_id,
               'placementId',created.planned_placement_id,
               'lineageStatus',CASE
                 WHEN created.reply_id IS NULL THEN 'UNATTRIBUTED'
                 ELSE 'OUTREACH_DERIVED'
               END,
               'status',created.status,
               'matchStatus',created.match_status,
               'initialValidationStatus',created.initial_validation_status,
               'version',created.version
             ),
             1,now(),now()+interval '24 hours',$4,$4
             FROM created
           RETURNING request_hash AS "requestHash",
                     response_body AS "responseBody"
         )
         SELECT 'completed' AS state,* FROM completed
         UNION ALL
         SELECT 'replay' AS state,* FROM prior`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.actorId,
          input.candidateId,
          input.sourceType,
          input.sourceExternalId ?? null,
          input.sourcePageUrl ?? null,
          input.normalizedSourceUrl ?? null,
          input.normalizedSourceUrlHash ?? null,
          input.targetUrl,
          input.normalizedTargetUrl,
          input.normalizedTargetUrlHash,
          input.urlNormalizationVersion,
          input.status,
          input.matchStatus,
          input.initialValidationStatus,
          JSON.stringify(input.discoveryEvidenceSnapshot),
          input.discoveryEvidenceHash,
          input.evidenceContractVersion,
          input.evidenceSchemaVersion,
          input.idempotencyKey,
          input.idempotencyRecordId,
          input.requestHash,
          input.opportunityId ?? null,
          input.replyId ?? null,
          input.plannedPlacementId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw conflict("Placement Candidate could not be created.");
      }
      const rawResponse = row.responseBody as
        Record<string, unknown> | undefined;
      const responseBody =
        rawResponse === undefined
          ? undefined
          : {
              candidateId: String(rawResponse.candidateId),
              ...(rawResponse.opportunityId === null ||
              rawResponse.opportunityId === undefined
                ? {}
                : { opportunityId: String(rawResponse.opportunityId) }),
              ...(rawResponse.replyId === null ||
              rawResponse.replyId === undefined
                ? {}
                : { replyId: String(rawResponse.replyId) }),
              placementId:
                rawResponse.placementId === null ||
                rawResponse.placementId === undefined
                  ? String(rawResponse.candidateId)
                  : String(rawResponse.placementId),
              lineageStatus:
                rawResponse.replyId === null ||
                rawResponse.replyId === undefined
                  ? ("UNATTRIBUTED" as const)
                  : ("OUTREACH_DERIVED" as const),
              status: rawResponse.status as
                "PENDING_MATCH" | "PENDING_VALIDATION",
              matchStatus: rawResponse.matchStatus as
                "UNMATCHED" | "AUTO_MATCHED",
              initialValidationStatus: "PENDING" as const,
              version: Number(rawResponse.version),
            };
      const state: "replay" | "completed" =
        row.state === "replay" ? "replay" : "completed";
      const resultBase = {
        state,
        requestHash: String(row.requestHash),
      };
      return responseBody === undefined
        ? resultBase
        : { ...resultBase, responseBody };
    },
  };
}

function mapReportExport(row: Record<string, unknown>): ReportExportRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organizationId),
    workspaceId: String(row.workspaceId),
    websiteProjectId: String(row.websiteProjectId),
    reportKey: String(row.reportKey),
    reportRevisionId: String(row.reportRevisionId),
    format: row.format as ReportExportRecord["format"],
    status: row.status as ReportExportRecord["status"],
    requestedBy: String(row.requestedBy),
    correlationId: String(row.correlationId),
    objectReference:
      (row.objectReference as ReportExportRecord["objectReference"]) ?? null,
    createdAt: row.createdAt as Date,
    completedAt: (row.completedAt as Date | null) ?? null,
    expiresAt: (row.expiresAt as Date | null) ?? null,
    failureCode: (row.failureCode as string | null) ?? null,
  };
}

const reportExportSelection = `
  id,organization_id AS "organizationId",workspace_id AS "workspaceId",
  website_project_id AS "websiteProjectId",report_key AS "reportKey",
  report_revision_id AS "reportRevisionId",format,status,
  requested_by AS "requestedBy",correlation_id AS "correlationId",
  object_reference AS "objectReference",created_at AS "createdAt",
  completed_at AS "completedAt",expires_at AS "expiresAt",
  failure_code AS "failureCode"`;

function createReportExportRepository(
  pool: BacklinkTenantPool,
): ReportExportRepository {
  const inScope = <T>(
    scope: ReportExportScope,
    work: (client: BacklinkTransactionClient) => Promise<T>,
  ) => withBacklinkTenantTransaction(pool, scope, work);
  return {
    create: (record) =>
      inScope(record, async (client) => {
        await client.query(
          `INSERT INTO backlink_report_exports (
           id,organization_id,workspace_id,website_project_id,
           report_key,report_revision_id,format,status,requested_by,
           correlation_id,object_reference,created_at,completed_at,
           expires_at,failure_code
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15
         )`,
          [
            record.id,
            record.organizationId,
            record.workspaceId,
            record.websiteProjectId,
            record.reportKey,
            record.reportRevisionId,
            record.format,
            record.status,
            record.requestedBy,
            record.correlationId,
            record.objectReference === null
              ? null
              : JSON.stringify(record.objectReference),
            record.createdAt,
            record.completedAt,
            record.expiresAt,
            record.failureCode,
          ],
        );
      }),
    get: (scope, exportId) =>
      inScope(scope, async (client) => {
        const result = await client.query(
          `SELECT ${reportExportSelection}
           FROM backlink_report_exports
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            exportId,
          ],
        );
        return result.rows[0] === undefined
          ? null
          : mapReportExport(result.rows[0]);
      }),
    claim: (scope, exportId) =>
      inScope(scope, async (client) => {
        const result = await client.query(
          `UPDATE backlink_report_exports
            SET status='running'
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4 AND status='queued'
        RETURNING ${reportExportSelection}`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            exportId,
          ],
        );
        return result.rows[0] === undefined
          ? null
          : mapReportExport(result.rows[0]);
      }),
    complete: (input) =>
      inScope(input.scope, async (client) => {
        const result = await client.query(
          `UPDATE backlink_report_exports
            SET status='completed',object_reference=$5::jsonb,
                completed_at=$6,expires_at=$7,failure_code=NULL
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4 AND status='running'
        RETURNING ${reportExportSelection}`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            input.scope.websiteProjectId,
            input.exportId,
            JSON.stringify(input.objectReference),
            input.completedAt,
            input.expiresAt,
          ],
        );
        if (result.rows[0] === undefined) {
          throw conflict("Report Export is not running.");
        }
        return mapReportExport(result.rows[0]);
      }),
    fail: (input) =>
      inScope(input.scope, async (client) => {
        const result = await client.query(
          `UPDATE backlink_report_exports
            SET status='failed',failure_code=$5
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4
            AND status IN ('queued','running')
        RETURNING ${reportExportSelection}`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            input.scope.websiteProjectId,
            input.exportId,
            input.failureCode,
          ],
        );
        if (result.rows[0] === undefined) {
          throw conflict("Report Export cannot transition to failed.");
        }
        return mapReportExport(result.rows[0]);
      }),
  };
}

function createSettingsGovernanceService(
  pool: BacklinkTenantPool,
): BacklinksPrivateApiDependencies["settingsGovernanceService"] {
  const inScope = <T>(
    scope: BacklinkTenantContext,
    work: (client: BacklinkTransactionClient) => Promise<T>,
  ) => withBacklinkTenantTransaction(pool, scope, work);
  return {
    getView: (scope) =>
      inScope(scope, async (client) => {
        const settings = await client.query(
          `SELECT id,version,settings_values AS values
           FROM backlink_project_settings_versions
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
          ORDER BY version DESC LIMIT 1`,
          [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
        );
        const switches = await client.query(
          `SELECT DISTINCT ON (layer,capability,provider)
                layer,capability,provider,version,blocked
           FROM backlink_kill_switch_versions
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
          ORDER BY layer,capability,provider,version DESC`,
          [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
        );
        const retention = await client.query(
          `SELECT id,version,rules,exceptions
           FROM backlink_retention_policy_versions
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
          ORDER BY version DESC LIMIT 1`,
          [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
        );
        const settingsRow = settings.rows[0];
        const retentionRow = retention.rows[0];
        if (settingsRow === undefined || retentionRow === undefined) {
          throw new Error("BACKLINKS_RUNTIME_GOVERNANCE_NOT_INITIALIZED");
        }
        const settingsValues = settingsRow.values as Readonly<
          Record<string, unknown>
        >;
        const stringArray = (value: unknown): string[] =>
          Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [];
        return {
          settings: {
            id: String(settingsRow.id),
            version: Number(settingsRow.version),
            values: {
              reportingTimezone: String(settingsValues.reportingTimezone),
              reportLookbackDays: Number(settingsValues.reportLookbackDays),
              exportExpiryHours: Number(settingsValues.exportExpiryHours),
              discoveryTargetAudiences: stringArray(
                settingsValues.discoveryTargetAudiences,
              ),
              discoveryPartnershipGoals: stringArray(
                settingsValues.discoveryPartnershipGoals,
              ),
              discoveryExplicitCompetitorDomains: stringArray(
                settingsValues.discoveryExplicitCompetitorDomains,
              ),
            },
          },
          killSwitches: switches.rows.map((row) => ({
            capability: String(row.capability),
            provider: row.provider === null ? null : String(row.provider),
            effectiveBlocked: row.blocked === true,
            sourceLayer: row.layer as "project" | "provider",
            sourceScopeId: scope.websiteProjectId,
            sourceVersion: Number(row.version),
            editable: true,
          })),
          editableKillSwitchLayers: ["project", "provider"],
          retention: {
            id: String(retentionRow.id),
            version: Number(retentionRow.version),
            rules: [
              ...(retentionRow.rules as readonly {
                category: string;
                retainForDays: number;
              }[]),
            ],
            exceptions: [
              ...(retentionRow.exceptions as readonly (
                | "legal_hold"
                | "audit_record"
                | "lifecycle_record"
                | "active_suppression"
              )[]),
            ],
          },
        };
      }),
    updateSettings: (input) =>
      inScope(input.scope, async (client) => {
        const result = await client.query(
          `INSERT INTO backlink_project_settings_versions (
           id,organization_id,workspace_id,website_project_id,
           version,settings_values,created_by
         )
         SELECT $4,$1,$2,$3,current.version+1,$6::jsonb,$7
           FROM LATERAL (
             SELECT version
               FROM backlink_project_settings_versions
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
              ORDER BY version DESC LIMIT 1
              FOR UPDATE
           ) current
          WHERE current.version=$5
        RETURNING id,version,settings_values AS values`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            input.scope.websiteProjectId,
            randomUUID(),
            input.expectedVersion,
            JSON.stringify(input.values),
            input.actorId,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw conflict("Settings expectedVersion is stale.");
        }
        return {
          id: String(row.id),
          version: Number(row.version),
          values: row.values as typeof input.values,
        };
      }),
    updateKillSwitch: (input) =>
      inScope(input.scope, async (client) => {
        const result = await client.query(
          `WITH current AS (
           SELECT version
             FROM backlink_kill_switch_versions
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND layer=$4
              AND capability=$5 AND provider IS NOT DISTINCT FROM $6
            ORDER BY version DESC LIMIT 1
            FOR UPDATE
         ), inserted AS (
           INSERT INTO backlink_kill_switch_versions (
             id,organization_id,workspace_id,website_project_id,
             layer,capability,provider,version,blocked,reason,created_by
           )
           SELECT
             $7,$1,$2,$3,$4,$5,$6,
             COALESCE(current.version,0)+1,$9,$10,$11
             FROM (SELECT 1) seed
             LEFT JOIN current ON true
            WHERE COALESCE(current.version,0)=$8
           RETURNING layer,capability,provider,version,blocked
         )
         SELECT * FROM inserted`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            input.scope.websiteProjectId,
            input.layer,
            input.capability,
            input.provider,
            randomUUID(),
            input.expectedVersion,
            input.blocked,
            input.reason,
            input.actorId,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw conflict("Kill Switch expectedVersion is stale.");
        }
        return {
          capability: String(row.capability),
          provider: row.provider === null ? null : String(row.provider),
          effectiveBlocked: row.blocked === true,
          sourceLayer: row.layer as "project" | "provider",
          sourceScopeId: input.scope.websiteProjectId,
          sourceVersion: Number(row.version),
          editable: true,
        };
      }),
  };
}

async function createApiDependencies(
  context: BacklinksRuntimeFactoryContext,
): Promise<BacklinksPrivateApiDependencies> {
  const capabilities = readBacklinksLiveCapabilities();
  const providerHealth = createBacklinksProvidersHealth();
  const dataForSeoAvailable =
    capabilities.dataForSeoEnabled &&
    providerHealth.dataForSeo.externalAvailability === "available";
  const browserProviderAvailable =
    capabilities.browserProviderEnabled &&
    providerHealth.browser.externalAvailability === "available";
  const aiProviderAvailable =
    capabilities.aiProviderEnabled &&
    providerHealth.ai.externalAvailability === "available";
  if (context.process !== "api") {
    throw new Error("BACKLINKS_RUNTIME_PROCESS_MISMATCH");
  }
  const pool = tenantPool(context);
  const projectContext = createProjectContextPort(pool);

  const assessmentFactory: QueryFactory<AssessmentQuery> =
    createAssessmentQuery;
  const draftFactory: QueryFactory<DraftQuery> = (client) =>
    createDraftQuery(createDraftGenerationRepository(client));
  const opportunitiesFactory: QueryFactory<OpportunitiesQuery> =
    createOpportunitiesQuery;
  const placementLinksFactory: QueryFactory<PlacementLinksQuery> =
    createPlacementLinksQuery;
  const recommendationsFactory: QueryFactory<RecommendationsQuery> =
    createRecommendationsQuery;
  const resourceLibraryFactory: QueryFactory<ResourceLibraryQuery> =
    createResourceLibraryQuery;
  const replyMailContentReader =
    capabilities.secretStoreRoot !== null
      ? createLocalProductReplyMailContentReader(
          resolve(capabilities.secretStoreRoot, "..", "mail-raw"),
        )
      : {
          read: async () => providerDisabled("Reply Mail object storage"),
        };
  const replyMailFactory: QueryFactory<ReplyMailQuery> = (client) =>
    createReplyMailQuery({
      client,
      contentReader: replyMailContentReader,
    });
  let readGmailWorkerMode: () => Promise<SendIntentWorkerMode> = async () =>
    "unknown";
  const sendIntentFactory: QueryFactory<SendIntentQuery> = (client) =>
    createSendIntentQuery(client, {
      buildIdentity: context.buildIdentity.buildId,
      workerMode: () => readGmailWorkerMode(),
    });
  const sendIntentListFactory: QueryFactory<SendIntentListQuery> = (client) =>
    createSendIntentQuery(client, {
      buildIdentity: context.buildIdentity.buildId,
      workerMode: () => readGmailWorkerMode(),
    });
  const summaryFactory: QueryFactory<SummaryQuery> = (client) => ({
    async getSummary() {
      await client.query("SELECT 1");
      return Object.freeze({});
    },
  });
  const profileConfiguration = capabilities.dataForSeoEnabled
    ? readLocalProductDataForSeoConfiguration()
    : null;

  const profileEstimatedCostMicros =
    (profileConfiguration?.estimatedCostMicros ??
      Number(process.env.DATAFORSEO_ESTIMATED_COST_MICROS ?? 27_600)) * 2;
  const profileFactory: QueryFactory<BacklinkProfileStore> = (client) =>
    createBacklinkProfileStore(client, {
      providerEnabled: capabilities.dataForSeoEnabled,
      providerAvailable: dataForSeoAvailable,
      estimatedCostMicros: profileEstimatedCostMicros,
    });

  const queries = Object.freeze({
    getAssessment: scopedMethod(pool, assessmentFactory, "getAssessment"),
    getJob: scopedMethod(pool, draftFactory, "getJob"),
    findLatestJob: scopedMethod(pool, draftFactory, "findLatestJob"),
    getDraft: scopedMethod(pool, draftFactory, "getDraft"),
    listOpportunities: scopedMethod(
      pool,
      opportunitiesFactory,
      "listOpportunities",
    ),
    getOpportunity: scopedMethod(pool, opportunitiesFactory, "getOpportunity"),
    listLinks: scopedMethod(pool, placementLinksFactory, "listLinks"),
    getCandidateLink: scopedMethod(
      pool,
      placementLinksFactory,
      "getCandidateLink",
    ),
    getPlacementLink: scopedMethod(
      pool,
      placementLinksFactory,
      "getPlacementLink",
    ),
    listPlacementEvents: scopedMethod(
      pool,
      placementLinksFactory,
      "listPlacementEvents",
    ),
    getPlacementEvidence: scopedMethod(
      pool,
      placementLinksFactory,
      "getPlacementEvidence",
    ),
    listRecommendations: scopedMethod(
      pool,
      recommendationsFactory,
      "listRecommendations",
    ),
    getRecommendationInventoryStatus: scopedMethod(
      pool,
      recommendationsFactory,
      "getRecommendationInventoryStatus",
    ),
    listResourceLibrary: scopedMethod(
      pool,
      resourceLibraryFactory,
      "listResourceLibrary",
    ),
    listMailMessages: scopedMethod(pool, replyMailFactory, "listMailMessages"),
    getMailMessage: scopedMethod(pool, replyMailFactory, "getMailMessage"),
    getMailThread: scopedMethod(pool, replyMailFactory, "getMailThread"),
    getSendIntent: scopedMethod(pool, sendIntentFactory, "getSendIntent"),
    listSendIntents: scopedMethod(
      pool,
      sendIntentListFactory,
      "listSendIntents",
    ),
    getSummary: scopedMethod(pool, summaryFactory, "getSummary"),
  });

  const contactFactory: QueryFactory<ContactCommands> = createContactCommands;
  const contactCommands: ContactCommands = Object.freeze({
    listCandidates: scopedMethod(pool, contactFactory, "listCandidates"),
    listOpportunityContacts: scopedMethod(
      pool,
      contactFactory,
      "listOpportunityContacts",
    ),
    createManualCandidate: scopedMethod(
      pool,
      contactFactory,
      "createManualCandidate",
    ),
    confirm: scopedMethod(pool, contactFactory, "confirm"),
  });
  const contactEnrichmentFactory: QueryFactory<ContactEnrichmentCommands> = (
    client,
  ) =>
    createContactEnrichmentCommands(client, {
      maxPages: capabilities.contactEnrichmentMaxPages,
      maxDepth: capabilities.contactEnrichmentMaxDepth,
      maxAttempts: capabilities.contactEnrichmentMaxAttempts,
      browserAllowed: browserProviderAvailable,
    });
  const contactEnrichmentCommands: ContactEnrichmentCommands = Object.freeze({
    runCurrentPool: scopedMethod(
      pool,
      contactEnrichmentFactory,
      "runCurrentPool",
    ),
    start: scopedMethod(pool, contactEnrichmentFactory, "start"),
    get: scopedMethod(pool, contactEnrichmentFactory, "get"),
    retry: scopedMethod(pool, contactEnrichmentFactory, "retry"),
    retryUnpublished: scopedMethod(
      pool,
      contactEnrichmentFactory,
      "retryUnpublished",
    ),
    addManualCandidate: scopedMethod(
      pool,
      contactEnrichmentFactory,
      "addManualCandidate",
    ),
    correctCandidate: scopedMethod(
      pool,
      contactEnrichmentFactory,
      "correctCandidate",
    ),
  });

  const aiRuntime = aiProviderAvailable
    ? createLocalProductAiRuntime({
        pool,
        secretStoreRoot:
          capabilities.secretStoreRoot ??
          providerDisabled("AI Provider Secret Store"),
        configuration: readLocalProductAiConfiguration(),
      })
    : null;
  const draftCommands: DraftCommands = createDraftCommands({
    repository: createScopedDraftGenerationRepository(pool),
    budget: aiRuntime?.budgetGate ?? { assertAvailable: async () => {} },
    newId: randomUUID,
    now: () => new Date(),
    promptVersion: "backlinks-outreach-draft.v2",
    outputSchemaVersion: "outreach-draft-output.v2",
    generationMode: "MODEL",
    modelProviderAvailable: () => aiRuntime !== null,
    scheduler: createTemporalDraftGenerationScheduler(
      context.temporal.workflow,
      backlinksRuntimeContract.taskQueue,
    ),
  });
  const draftEditingFactory: QueryFactory<DraftEditingCommands> = (client) =>
    createDraftEditingCommands({
      repository: createDraftEditingRepository(client),
      newId: randomUUID,
      now: () => new Date(),
    });
  const draftEditingCommands: DraftEditingCommands = Object.freeze({
    saveManualVersion: scopedMethod(
      pool,
      draftEditingFactory,
      "saveManualVersion",
    ),
    approve: scopedMethod(pool, draftEditingFactory, "approve"),
  });

  const gmailRepository = new PostgresqlGmailConnectionRepository({
    pool,
    projectGovernance: {
      gmailSendEnabled: capabilities.gmailSendEnabled,
      gmailSyncEnabled: capabilities.gmailSyncEnabled,
    },
  });
  const gmailSecretStore =
    capabilities.secretStoreRoot === null
      ? null
      : new SecretStoreClientAdapter({
          config: {
            enabled: true,
            provider: "platform-secret-store",
          },
          client: new LocalProductSecretStoreClient({
            rootDirectory: capabilities.secretStoreRoot,
          }),
        });
  const gmailWorkerAvailable = async (): Promise<boolean> => {
    try {
      const workflowService = context.temporal.connection
        .workflowService as Readonly<{
        describeTaskQueue(
          input: Readonly<{
            namespace: string;
            taskQueue: Readonly<{ name: string; kind: number }>;
            taskQueueType: number;
            reportStats: boolean;
          }>,
        ): Promise<Readonly<{ pollers?: readonly unknown[] }>>;
      }>;
      const status = await workflowService.describeTaskQueue({
        namespace: context.temporal.workflow.options.namespace,
        taskQueue: {
          name: backlinksRuntimeContract.taskQueue,
          kind: 1,
        },
        taskQueueType: 1,
        reportStats: false,
      });
      return (status.pollers?.length ?? 0) > 0;
    } catch {
      return false;
    }
  };
  readGmailWorkerMode = async () => {
    if (process.env.BACKLINKS_WORKER_EXECUTION_MODE !== "normal") {
      return "quiesced";
    }
    return (await gmailWorkerAvailable()) ? "normal" : "unavailable";
  };
  let gmailConnectionCommands: GmailConnectionCommands;
  if (!capabilities.googleOauthEnabled) {
    gmailConnectionCommands = Object.freeze({
      connect: async () => providerDisabled("Google OAuth"),
      complete: async () => providerDisabled("Google OAuth"),
      select: async () => providerDisabled("Gmail connection"),
      disconnect: async () => providerDisabled("Gmail connection"),
    });
  } else {
    const secretStore = gmailSecretStore ?? providerDisabled("Secret Store");
    const clientSecretReference = parseLocalProductSecretReference(
      capabilities.googleOauthClientSecretReference ??
        providerDisabled("Google OAuth Client Secret"),
      secretKinds.googleOauthClientSecret,
    );
    const googleAuth = new GoogleAuthClientAdapter({
      config: {
        enabled: true,
        redirectUris: [
          capabilities.googleOauthRedirectUri ??
            providerDisabled("Google OAuth Redirect URI"),
        ],
      },
      client: new GoogleAuthLibraryClient({
        clientId:
          capabilities.googleOauthClientId ??
          providerDisabled("Google OAuth Client ID"),
        clientSecret: await secretStore.resolve({
          reference: clientSecretReference,
          context: {
            organizationId: "local-product",
            subjectProvider: "google",
          },
        }),
      }),
    });
    const completion = new SecretBackedGmailConnectionRepository({
      secretStore,
      googleAuth,
      persistence: gmailRepository,
      refreshLock: new PostgresqlGmailConnectionRefreshLock(pool),
    });
    const disconnectWorkflow = new GmailConnectionDisconnectWorkflow({
      persistence: gmailRepository,
      googleAuth,
      secretStore,
      retryScheduler: {
        async schedule() {
          throw new Error("GMAIL_REVOCATION_RETRY_NOT_REGISTERED");
        },
      },
    });
    gmailConnectionCommands = createProductionGmailConnectionCommands({
      oauthAttempts: new OAuthAttemptService({
        repository: new PostgresqlOAuthAttemptRepository({
          pool,
          secretStore,
        }),
      }),
      googleAuth,
      completion,
      selector: gmailRepository,
      disconnectWorkflow,
      redirectUri:
        capabilities.googleOauthRedirectUri ??
        providerDisabled("Google OAuth Redirect URI"),
    });
  }
  const gmailPollingSyncCommands = createLocalProductGmailPollingSyncCommands({
    pool,
    workflowClient: context.temporal.workflow,
    taskQueue: backlinksRuntimeContract.taskQueue,
    capabilities,
  });
  const gmailConnectionQuery = createGmailConnectionQuery({
    reader: gmailRepository,
    readiness: {
      infrastructure: gmailRepository,
      sendRuntimeEnabled: capabilities.gmailSendEnabled,
      syncRuntimeEnabled: capabilities.gmailSyncEnabled,
      workerAvailable: gmailWorkerAvailable,
      async credentialAvailable(input) {
        if (gmailSecretStore === null) return false;
        try {
          const plaintext = await gmailSecretStore.resolve({
            reference: input.tokenSecretReference,
            context: {
              organizationId: input.organizationId,
              subjectProvider: "google",
              connectionId: input.gmailConnectionId,
            },
          });
          return plaintext.trim().length > 0;
        } catch {
          return false;
        }
      },
      syncStatus: (input) => gmailPollingSyncCommands.status(input),
    },
  });

  const opportunityFactory: QueryFactory<OpportunityCommands> = (client) =>
    createOpportunityCommands(createOpportunityRepository(client));
  const opportunityCommands: OpportunityCommands = Object.freeze({
    createFromRecommendation: scopedMethod(
      pool,
      opportunityFactory,
      "createFromRecommendation",
    ),
    transitionBusinessStage: scopedMethod(
      pool,
      opportunityFactory,
      "transitionBusinessStage",
    ),
    patchManagement: scopedMethod(pool, opportunityFactory, "patchManagement"),
  });
  const cooperationPathOpportunityFactory: QueryFactory<
    CooperationPathOpportunityCommands
  > = (client) =>
    createCooperationPathOpportunityCommands(
      createCooperationPathOpportunityRepository(client),
    );
  const cooperationPathOpportunityCommands: CooperationPathOpportunityCommands =
    Object.freeze({
      createFromVerifiedPath: scopedMethod(
        pool,
        cooperationPathOpportunityFactory,
        "createFromVerifiedPath",
      ),
      patchManualContent: scopedMethod(
        pool,
        cooperationPathOpportunityFactory,
        "patchManualContent",
      ),
      transitionManualAction: scopedMethod(
        pool,
        cooperationPathOpportunityFactory,
        "transitionManualAction",
      ),
    });

  const placementCandidateFactory: QueryFactory<PlacementCandidateCommand> = (
    client,
  ) =>
    createPlacementCandidateCommand({
      repository: createPlacementCandidateRepository(client),
    });
  const placementInitialValidationStarter =
    createTemporalPlacementInitialValidationStarter(
      context.temporal.workflow,
      backlinksRuntimeContract.taskQueue,
    );
  const placementCandidateCommand: PlacementCandidateCommand = Object.freeze({
    async execute(input) {
      const result = await withBacklinkTenantTransaction(
        pool,
        tenantScopeFrom(input),
        (transaction) => placementCandidateFactory(transaction).execute(input),
      );
      if (result.initialValidationRequest !== undefined) {
        await placementInitialValidationStarter.start(
          result.initialValidationRequest,
        );
      }
      return result;
    },
  });
  const placementReverifyFactory: QueryFactory<PlacementReverifyCommand> = (
    client,
  ) => createPlacementReverifyCommand(client);
  const placementReverifyCommand: PlacementReverifyCommand = Object.freeze({
    execute: scopedMethod(pool, placementReverifyFactory, "execute"),
  });
  const placementReviewFactory: QueryFactory<PlacementReviewCommand> = (
    client,
  ) =>
    createPlacementReviewCommand({
      repository: createPlacementReviewRepository(client),
    });
  const placementReviewCommand: PlacementReviewCommand = Object.freeze({
    confirm: scopedMethod(pool, placementReviewFactory, "confirm"),
    reject: scopedMethod(pool, placementReviewFactory, "reject"),
  });

  const baseRecommendationSeedCommands = createRecommendationSeedCommands(
    createRecommendationSeedRepository(pool),
  );
  const recommendationSeedCommands: RecommendationPoolV2GenerationLifecycleCommands =
    createRecommendationPoolV2GenerationLauncher({
      seedCommands: baseRecommendationSeedCommands,
      repository: createRecommendationPoolV2GenerationLaunchRepository(pool),
      starter: createTemporalRecommendationPoolV2Starter(
        context.temporal.workflow,
        backlinksRuntimeContract.taskQueue,
      ),
      timing: createScopedRecommendationPoolV2TimingRecorder(pool),
    });
  const recommendationUserReleaseCommands =
    createRecommendationUserReleaseCommands(
      createRecommendationUserReleaseRepository(pool),
    );
  const recommendationFeedRepository = createRecommendationFeedRepository(pool);

  const metricDashboardQuery: MetricDashboardQuery = Object.freeze({
    getDashboard: scopedMethod(
      pool,
      createMetricDashboardQuery,
      "getDashboard",
    ),
  });
  const reportOverviewQuery: ReportOverviewQuery = Object.freeze({
    listPublished: scopedMethod(
      pool,
      createReportOverviewQuery,
      "listPublished",
    ),
  });

  const reportExportRepository = createReportExportRepository(pool);
  const reportExportWorkflow = createReportExportWorkflow({
    repository: reportExportRepository,
    queue: {
      async enqueue(input) {
        await reportExportRepository.fail({
          scope: input.scope,
          exportId: input.exportId,
          failedAt: new Date(),
          failureCode: "BACKLINK_REPORT_EXPORT_EXECUTOR_DISABLED",
        });
        providerDisabled("Report Export executor");
      },
    },
    renderers: {},
    storage: {
      putPrivate: async () => providerDisabled("Report Export storage"),
      authorizeDownload: async () => providerDisabled("Report Export storage"),
    },
    access: {
      canRead: ({ record, actorId }) => record.requestedBy === actorId,
    },
    newId: randomUUID,
    now: () => new Date(),
    expiryMilliseconds: 24 * 60 * 60 * 1000,
  });

  const replyMatchCommands = createReplyMatchCommands({
    repository: new PostgresqlReplyMatchRepository({ pool }),
  });
  const negotiationFactsService = createPostgresqlNegotiationFactsService({
    pool,
  });
  const sendIntentCommands: SendIntentCommands =
    createLocalProductSendIntentCommands(
      pool,
      capabilities,
      gmailWorkerAvailable,
    );
  const inventoryMonitoringStarter = createTemporalPlacementMonitoringStarter(
    context.temporal.workflow,
    backlinksRuntimeContract.taskQueue,
  );
  const backlinkProfileService = createBacklinkProfileService({
    queryStore: Object.freeze({
      getProfile: scopedMethod(pool, profileFactory, "getProfile"),
      listInventory: scopedMethod(pool, profileFactory, "listInventory"),
      getSyncJob: scopedMethod(pool, profileFactory, "getSyncJob"),
      createSyncJob: scopedMethod(pool, profileFactory, "createSyncJob"),
      importInventory: scopedMethod(pool, profileFactory, "importInventory"),
      updateInventoryPolicy: scopedMethod(
        pool,
        profileFactory,
        "updateInventoryPolicy",
      ),
      requestInventoryCheck: scopedMethod(
        pool,
        profileFactory,
        "requestInventoryCheck",
      ),
      listDirectObservations: scopedMethod(
        pool,
        profileFactory,
        "listDirectObservations",
      ),
    }),
    commandStore: async (profileContext, input) =>
      withBacklinkTenantTransaction(
        pool,
        tenantScopeFrom(profileContext),
        async (client) => {
          const endpointsAllowed =
            profileConfiguration !== null &&
            [
              "https://api.dataforseo.com/v3/backlinks/summary/live",
              "https://api.dataforseo.com/v3/backlinks/backlinks/live",
            ].every((endpoint) =>
              profileConfiguration.endpointAllowlist.includes(endpoint),
            );
          const gate = await client.query(
            `
            WITH switches AS (
              SELECT
                COALESCE((
                  SELECT NOT blocked
                    FROM backlink_kill_switch_versions
                   WHERE organization_id=$1 AND workspace_id=$2
                     AND website_project_id=$3
                     AND capability='backlinks.dataforseo.v1'
                     AND layer='project' AND provider IS NULL
                   ORDER BY version DESC LIMIT 1
                ),false)
                AND COALESCE((
                  SELECT NOT blocked
                    FROM backlink_kill_switch_versions
                   WHERE organization_id=$1 AND workspace_id=$2
                     AND website_project_id=$3
                     AND capability='backlinks.dataforseo.v1'
                     AND layer='provider' AND provider='dataforseo'
                   ORDER BY version DESC LIMIT 1
                ),false) available
            )
            SELECT switches.available
              FROM switches
          `,
            [
              profileContext.tenant.organizationId,
              profileContext.tenant.workspaceId,
              profileContext.project.websiteProjectId,
            ],
          );
          const providerAvailable =
            dataForSeoAvailable &&
            endpointsAllowed &&
            gate.rows[0]?.available === true;
          return createBacklinkProfileStore(client, {
            providerEnabled: capabilities.dataForSeoEnabled,
            providerAvailable,
            estimatedCostMicros: profileEstimatedCostMicros,
          }).createSyncJob(profileContext, input);
        },
      ),
    scheduler: createTemporalBacklinkProfileSyncScheduler(
      context.temporal.workflow,
      backlinksRuntimeContract.taskQueue,
    ),
    inventoryScheduler: inventoryMonitoringStarter,
  });

  return Object.freeze({
    module: createBacklinksModule({
      projectContext,
      queries,
    }),
    contactCommands,
    contactEnrichmentCommands,
    draftCommands,
    draftEditingCommands,
    gmailConnectionCommands,
    gmailConnectionQuery,
    gmailPollingSyncCommands,
    cooperationPathOpportunityCommands,
    opportunityCommands,
    placementCandidateCommand,
    placementReverifyCommand,
    placementReviewCommand,

    recommendationFeedRepository,
    recommendationFeedObserver: createRecommendationFeedObserver(pool),
    recommendationSeedCommands,
    recommendationUserReleaseCommands,
    metricDashboardQuery,
    reportOverviewQuery,
    reportExportWorkflow,
    replyMatchCommands,
    negotiationFactsService,
    sendIntentCommands,
    settingsGovernanceService: createSettingsGovernanceService(pool),
    backlinkProfileService,
    projectContextProjectionCommand: createProjectContextProjectionCommand(
      pool,
      {
        aiProviderEnabled: capabilities.aiProviderEnabled,
        gmailSendEnabled: capabilities.gmailSendEnabled,
        gmailSyncEnabled: capabilities.gmailSyncEnabled,
        dataForSeoEnabled: capabilities.dataForSeoEnabled,
        browserProviderEnabled: capabilities.browserProviderEnabled,
      },
    ),
  });
}

async function createWorkerRegistrations(
  context: BacklinksRuntimeFactoryContext,
) {
  const recoveryMode =
    process.env.BACKLINKS_WORKER_EXECUTION_MODE === "recovery";
  if (recoveryMode) {
    throw new Error("BACKLINKS_V1_RECOMMENDATION_RECOVERY_RETIRED");
  }

  const capabilities = readBacklinksLiveCapabilities();
  const providerHealth = createBacklinksProvidersHealth();
  const dataForSeoAvailable =
    capabilities.dataForSeoEnabled &&
    providerHealth.dataForSeo.externalAvailability === "available";
  const browserProviderAvailable =
    capabilities.browserProviderEnabled &&
    providerHealth.browser.externalAvailability === "available";
  const aiProviderAvailable =
    capabilities.aiProviderEnabled &&
    providerHealth.ai.externalAvailability === "available";
  const gmailProviderAvailable =
    providerHealth.gmail.externalAvailability === "available";
  if (context.process !== "worker") {
    throw new Error("BACKLINKS_RUNTIME_PROCESS_MISMATCH");
  }
  const pool = tenantPool(context);
  const workerId = `backlinks-worker:${process.pid}`;
  const workerAuthority = localProductWorkerAuthority();
  console.log(
    JSON.stringify({
      event: "backlinks.worker.product-runtime.configured",
      runtimeMode: process.env.BACKLINKS_RUNTIME_MODE ?? "DISABLED",
      projectConsumersEnabled: workerAuthority !== null,
      dataForSeoAvailable,
      browserProviderAvailable,
      aiProviderAvailable,
      gmailProviderAvailable,
    }),
  );

  const projectScopeProvider =
    workerAuthority === null
      ? null
      : createPostgresqlProjectScopeProvider(pool);
  const placementMonitoringConsumer =
    createTemporalPlacementMonitoringInitializationConsumer(
      context.temporal.workflow,
      backlinksRuntimeContract.taskQueue,
      workerId,
    );
  const projectAnalysisStarter = createTemporalBacklinkProjectAnalysisStarter(
    context.temporal.workflow,
    backlinksRuntimeContract.taskQueue,
  );
  const projectAnalysisRelay =
    workerAuthority === null
      ? createBacklinkOutboxRelay({
          repository: createOutboxRelayRepository(context.pool),
          workflowStarter: projectAnalysisStarter,
        })
      : null;
  const projectAnalysisRecovery =
    workerAuthority === null
      ? createGlobalProjectAnalysisRecovery(context.pool)
      : null;
  const relay =
    workerAuthority === null
      ? createPlacementMonitoringRequestedOutboxRelay({
          repository: createOutboxRelayRepository(context.pool),
          consumer: placementMonitoringConsumer,
        })
      : null;

  const contactEnrichmentConsumer = createTemporalContactEnrichmentConsumer(
    context.temporal.workflow,
    backlinksRuntimeContract.taskQueue,
  );
  const contactEnrichmentRelay =
    workerAuthority === null
      ? createContactEnrichmentOutboxRelay({
          repository: createOutboxRelayRepository(context.pool),
          consumer: contactEnrichmentConsumer,
        })
      : null;
  const browserWorker = browserProviderAvailable
    ? createSharedBrowserWorkerAdapter({
        endpoint:
          capabilities.browserWorkerEndpoint ??
          providerDisabled("Browser Worker endpoint"),
        timeoutMs: capabilities.browserWorkerTimeoutMs,
      })
    : null;
  const contactEnrichmentActivity = createContactEnrichmentActivity({
    pool,
    browserWorker,
    fetchTimeoutMs: capabilities.contactEnrichmentFetchTimeoutMs,
  });
  const contactEnrichmentOptions = Object.freeze({
    maxPages: capabilities.contactEnrichmentMaxPages,
    maxDepth: capabilities.contactEnrichmentMaxDepth,
    maxAttempts: capabilities.contactEnrichmentMaxAttempts,
    browserAllowed: browserProviderAvailable,
  });
  const recommendationPoolV2Phase4Activities =
    createRecommendationPoolV2Phase4Activities({
      pool,
      contactEnrichmentOptions,
    });
  const placementSafeFetch = new SafeFetchAdapter({
    timeoutMs: capabilities.contactEnrichmentFetchTimeoutMs,
  });
  const placementBrowserFetch =
    browserWorker === null || workerAuthority === null
      ? undefined
      : Object.freeze({
          fetch: (request: Parameters<typeof placementSafeFetch.fetch>[0]) =>
            browserWorker.render({
              url: request.url,
              taskType: "backlink_validation",
              requestId: randomUUID(),
              organizationId: workerAuthority.organizationId,
              workspaceId: request.workspaceId,
              websiteProjectId: request.websiteProjectId,
              actorId: workerAuthority.actorId,
            }),
        });
  const commercialAssessmentBrowserFetch =
    browserWorker === null || workerAuthority === null
      ? undefined
      : Object.freeze({
          fetch: (request: Parameters<typeof placementSafeFetch.fetch>[0]) =>
            browserWorker.render({
              url: request.url,
              taskType: "seo_assessment",
              requestId: randomUUID(),
              organizationId: workerAuthority.organizationId,
              workspaceId: request.workspaceId,
              websiteProjectId: request.websiteProjectId,
              actorId: workerAuthority.actorId,
            }),
        });
  const placementActivities = createPlacementTemporalActivities({
    validationRepository:
      createScopedPlacementInitialValidationRepository(pool),
    safeFetch: placementSafeFetch,
    ...(placementBrowserFetch === undefined
      ? {}
      : { browserFetch: placementBrowserFetch }),
    monitorRepository: createScopedPlacementMonitorRepository(pool),
    inventoryMonitorRepository: createScopedInventoryMonitorRepository(pool),
    staticMonitorActivity: createPlacementStaticMonitorActivity(
      placementSafeFetch,
      placementBrowserFetch,
    ),
  });
  const placementMonitoringStarter = createTemporalPlacementMonitoringStarter(
    context.temporal.workflow,
    backlinksRuntimeContract.taskQueue,
  );
  const placementMonitoringConfiguration = Object.freeze({
    normalIntervalSeconds: boundedEnvironmentInteger(
      "BACKLINKS_PLACEMENT_MONITOR_NORMAL_INTERVAL_SECONDS",
      86_400,
      300,
      2_592_000,
    ),
    suspectedRecheckIntervalSeconds: boundedEnvironmentInteger(
      "BACKLINKS_PLACEMENT_MONITOR_SUSPECTED_INTERVAL_SECONDS",
      3_600,
      60,
      86_400,
    ),
    jitterWindowSeconds: boundedEnvironmentInteger(
      "BACKLINKS_PLACEMENT_MONITOR_JITTER_SECONDS",
      3_600,
      0,
      86_400,
    ),
  });
  const gmailSendRuntime = capabilities.gmailSendEnabled
    ? await createLocalProductGmailSendRuntime({
        pool,
        outboxClient: context.pool,
        workflowClient: context.temporal.workflow,
        taskQueue: backlinksRuntimeContract.taskQueue,
        capabilities,
      })
    : null;
  const gmailSyncRuntime = capabilities.gmailSyncEnabled
    ? await createLocalProductGmailPollingSyncRuntime({
        pool,
        capabilities,
      })
    : null;
  const draftGenerationRepository = createScopedDraftGenerationRepository(pool);
  const aiRuntime = aiProviderAvailable
    ? createLocalProductAiRuntime({
        pool,
        secretStoreRoot:
          capabilities.secretStoreRoot ??
          providerDisabled("AI Provider Secret Store"),
        configuration: readLocalProductAiConfiguration(),
      })
    : null;
  const dataForSeoConfiguration = capabilities.dataForSeoEnabled
    ? readLocalProductDataForSeoConfiguration()
    : null;

  const recommendationSeedCommands = createRecommendationSeedCommands(
    createRecommendationSeedRepository(pool),
  );
  const dataForSeoSecretStoreRoot =
    dataForSeoConfiguration === null
      ? null
      : (capabilities.secretStoreRoot ??
        providerDisabled("DataForSEO Secret Store"));
  if (
    dataForSeoConfiguration !== null &&
    dataForSeoSecretStoreRoot !== null &&
    dataForSeoAvailable
  ) {
    await assertLocalProductDataForSeoCredentialReady({
      secretStoreRoot: dataForSeoSecretStoreRoot,
      configuration: dataForSeoConfiguration,
    });
  }
  const dataForSeoRuntime =
    dataForSeoConfiguration === null || dataForSeoSecretStoreRoot === null
      ? null
      : createLocalProductDataForSeoRuntime({
          pool,
          secretStoreRoot: dataForSeoSecretStoreRoot,
          configuration: dataForSeoConfiguration,
          ...(commercialAssessmentBrowserFetch === undefined
            ? {}
            : { browserFetch: commercialAssessmentBrowserFetch }),
          blueprintGenerator: aiRuntime?.blueprint,
          recommendationSeedCommands,
          contactEnrichment: {
            limit: dataForSeoConfiguration.candidateLimit,
            options: {
              maxPages: capabilities.contactEnrichmentMaxPages,
              maxDepth: capabilities.contactEnrichmentMaxDepth,
              maxAttempts: capabilities.contactEnrichmentMaxAttempts,
              browserAllowed: browserProviderAvailable,
            },
          },
        });
  const prepareResourceSupply = createRecommendationHybridSupplyRuntime({
    pool, secretStoreRoot: capabilities.secretStoreRoot,
  });
  const recommendationPoolV2Activities = createRecommendationPoolV2Activities({
    pool,
    discoveryRoundExecutor:
      createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor({
        pool,
        runtime: dataForSeoAvailable ? dataForSeoRuntime : null,
      }),
    contactEnrichmentOptions,
    ...(prepareResourceSupply === undefined ? {} : { prepareResourceSupply }),
  });
  const backlinkProfileRuntime =
    dataForSeoConfiguration === null || dataForSeoSecretStoreRoot === null
      ? null
      : createLocalProductBacklinkProfileRuntime({
          pool,
          secretStoreRoot: dataForSeoSecretStoreRoot,
          configuration: dataForSeoConfiguration,
        });
  let relayTimer: NodeJS.Timeout | undefined;
  let relayRun: Promise<void> = Promise.resolve();
  const maxConcurrentContactEnrichmentJobs = 2;
  let nextContactScanAt = 0;
  let nextPlacementMonitorScanAt = 0;

  let nextBacklinkProfileScanAt = 0;
  const automaticProfileSync = automaticProfileSyncEnabled(
    process.env.BACKLINKS_PROFILE_SYNC_MODE,
  );
  let nextGmailTokenHealthCheckAt = 0;
  let nextGmailSendRecoveryAt = 0;
  const gmailTokenHealthRetryByConnection = new Map<
    string,
    Readonly<{
      consecutiveFailures: number;
      nextAttemptAt: number;
    }>
  >();
  const scopedWorkerId = (scope: BacklinkTenantContext, lane: string) =>
    [
      workerId,
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      lane,
    ].join(":");
  const projectAnalysisStaleBefore = () => new Date(Date.now() - 15 * 60_000);
  const logProjectFailure = (
    lane: string,
    scope: BacklinkTenantContext,
    error: unknown,
  ) => {
    console.error(
      JSON.stringify({
        event: "backlinks.project-scope.failed",
        lane,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        websiteProjectId: scope.websiteProjectId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const runLocalProjectLane = async (
    lane: Parameters<typeof runProjectScopedLane>[0]["lane"],
    run: Parameters<typeof runProjectScopedLane>[0]["run"],
  ) => {
    if (workerAuthority === null || projectScopeProvider === null) return;
    try {
      await runProjectScopedLane({
        provider: projectScopeProvider,
        organizationId: workerAuthority.organizationId,
        workspaceId: workerAuthority.workspaceId,
        lane,
        pageLimit: 25,
        run,
        onProjectError: (scope, error) => logProjectFailure(lane, scope, error),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "backlinks.project-scope.enumeration.failed",
          lane,
          organizationId: workerAuthority.organizationId,
          workspaceId: workerAuthority.workspaceId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const runRelay = () => {
    relayRun = relayRun
      .then(async () => {
        const staleClaimBefore = new Date(Date.now() - 30_000);
        if (projectAnalysisRelay !== null) {
          const rearmed =
            (await projectAnalysisRecovery?.rearm({
              workerId,
              limit: 10,
              staleBefore: projectAnalysisStaleBefore(),
            })) ?? 0;
          if (rearmed > 0) {
            console.log(
              JSON.stringify({
                event: "backlinks.project-analysis.recovered",
                rearmed,
              }),
            );
          }
          const outcome = await projectAnalysisRelay.runOnce({
            workerId,
            limit: 10,
            staleClaimBefore,
          });
          if (outcome.claimed > 0) {
            console.log(
              JSON.stringify({
                event: "backlinks.project-analysis.outbox.relay",
                ...outcome,
              }),
            );
          }
        } else {
          await runLocalProjectLane("project-analysis", async (scope) => {
            const projectWorkerId = scopedWorkerId(scope, "project-analysis");
            const rearmed = await withBacklinkTenantTransaction(
              pool,
              scope,
              (client) =>
                createScopedProjectAnalysisRecovery(client).rearm({
                  workerId: projectWorkerId,
                  limit: 10,
                  staleBefore: projectAnalysisStaleBefore(),
                }),
            );
            if (rearmed > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.project-analysis.recovered",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  rearmed,
                }),
              );
            }
            const outcome = await createBacklinkOutboxRelay({
              repository: createScopedOutboxRelayRepository(pool, scope),
              workflowStarter: projectAnalysisStarter,
            }).runOnce({
              workerId: projectWorkerId,
              limit: 10,
              staleClaimBefore,
            });
            if (outcome.claimed > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.project-analysis.outbox.relay",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  ...outcome,
                }),
              );
            }
          });
        }
        if (relay !== null) {
          const outcome = await relay.runOnce({
            workerId,
            limit: 10,
            staleClaimBefore,
          });
          if (outcome.claimed > 0) {
            console.log(
              JSON.stringify({
                event: "backlinks.outbox.relay",
                ...outcome,
              }),
            );
          }
        } else {
          const shouldScanPlacement = Date.now() >= nextPlacementMonitorScanAt;
          await runLocalProjectLane("placement-monitoring", async (scope) => {
            const projectWorkerId = scopedWorkerId(
              scope,
              "placement-monitoring",
            );
            const projectRelay = createPlacementMonitoringRequestedOutboxRelay({
              repository: createScopedOutboxRelayRepository(pool, scope),
              consumer: placementMonitoringConsumer,
            });
            const outcome = await projectRelay.runOnce({
              workerId: projectWorkerId,
              limit: 10,
              staleClaimBefore,
            });
            if (outcome.claimed > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.outbox.relay",
                  lane: "placement-monitoring",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  ...outcome,
                }),
              );
            }
            if (!shouldScanPlacement) return;
            const now = new Date();
            const placementDue = await withBacklinkTenantTransaction(
              pool,
              scope,
              (client) =>
                createMonitoringScheduleRepository(client).listDue({
                  ...scope,
                  dueAt: now,
                  limit: 10,
                }),
            );
            const inventoryDue = await withBacklinkTenantTransaction(
              pool,
              scope,
              (client) =>
                createInventoryMonitoringScheduleRepository(client).listDue({
                  ...scope,
                  dueAt: now,
                  limit: 10,
                }),
            );
            for (const placement of [...placementDue, ...inventoryDue]) {
              const scheduledFor = placement.nextCheckAt;
              const runSeed = [
                placement.placementId,
                placement.policyVersion,
                scheduledFor.toISOString(),
                "static",
              ].join(":");
              await placementMonitoringStarter.start({
                ...scope,
                placementId: placement.placementId,
                monitorPolicyId: placement.monitorPolicyId,
                policyVersion: placement.policyVersion,
                scheduledFor,
                runId: deterministicUuid(`${runSeed}:run`),
                observationId: deterministicUuid(`${runSeed}:observation`),
                workerId: projectWorkerId,
                now,
              });
            }
            if (placementDue.length + inventoryDue.length > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.placement-monitoring.scheduled",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  placementCount: placementDue.length,
                  inventoryCount: inventoryDue.length,
                }),
              );
            }
          });
          if (shouldScanPlacement) {
            nextPlacementMonitorScanAt = Date.now() + 5_000;
          }
        }
        let projectRecommendationWorkPending = false;
        if (workerAuthority !== null) {
          await runLocalProjectLane("recommendation-pool-v2", async (scope) => {
            const pending = await withBacklinkTenantTransaction(
              pool,
              scope,
              (client) => client.query(
                `SELECT EXISTS (
                   SELECT 1 FROM backlinks.backlink_jobs
                    WHERE organization_id=$1 AND workspace_id=$2
                      AND website_project_id=$3
                      AND job_type='recommendation_pool_v2_generation'
                      AND status IN ('queued','running','waiting_provider')
                 ) AS pending`,
                [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
              ),
            );
            projectRecommendationWorkPending ||=
              pending.rows[0]?.pending === true;
          });
        }

        if (
          workerAuthority !== null &&
          dataForSeoAvailable &&
          dataForSeoConfiguration !== null &&
          automaticProfileSync &&
          !projectRecommendationWorkPending &&
          Date.now() >= nextBacklinkProfileScanAt
        ) {
          const profileSyncScheduler =
            createTemporalBacklinkProfileSyncScheduler(
              context.temporal.workflow,
              backlinksRuntimeContract.taskQueue,
            );
          await runLocalProjectLane("backlink-profile", async (scope) => {
            const projectContext = await createWorkerProjectContext(
              pool,
              scope,
              workerAuthority.actorId,
            );
            if (projectContext === null) return;
            const due = await withBacklinkTenantTransaction(
              pool,
              scope,
              async (client) => {
                const result = await client.query(
                  `
                  SELECT search_after_token "searchAfterToken",
                         next_sync_at "nextSyncAt",version
                    FROM backlink_profile_sync_cursors cursor
                   WHERE (
                     organization_id,workspace_id,website_project_id,
                     provider,endpoint
                   )=($1,$2,$3,'dataforseo','/v3/backlinks/backlinks/live')
                     AND next_sync_at IS NOT NULL
                     AND next_sync_at<=now()
                     AND NOT EXISTS (
                       SELECT 1
                         FROM backlink_profile_sync_jobs job
                        WHERE (
                          job.organization_id,job.workspace_id,
                          job.website_project_id
                        )=(
                          cursor.organization_id,cursor.workspace_id,
                          cursor.website_project_id
                        )
                          AND (
                            job.status IN ('queued','running')
                            OR (
                            job.status='waiting_provider'
                              AND job.trigger_source IN (
                                'schedule','continuation'
                              )
                              AND job.sync_mode=CASE
                                WHEN cursor.search_after_token IS NULL
                                  THEN 'incremental'
                                ELSE 'page'
                              END
                              AND job.requested_cursor IS NOT DISTINCT FROM
                                  cursor.search_after_token
                            )
                          )
                     )
                   LIMIT 1
                `,
                  [
                    scope.organizationId,
                    scope.workspaceId,
                    scope.websiteProjectId,
                  ],
                );
                const row = result.rows[0];
                if (row === undefined) return null;
                const requestedCursor =
                  row.searchAfterToken === null
                    ? null
                    : String(row.searchAfterToken);
                return createBacklinkProfileStore(client, {
                  providerEnabled: true,
                  providerAvailable: dataForSeoAvailable,
                  estimatedCostMicros:
                    dataForSeoConfiguration.estimatedCostMicros * 2,
                }).createSyncJob(projectContext, {
                  idempotencyKey: [
                    "backlink-profile",
                    "schedule",
                    String(row.version),
                    new Date(String(row.nextSyncAt)).toISOString(),
                  ].join(":"),
                  syncMode: requestedCursor === null ? "incremental" : "page",
                  triggerSource:
                    requestedCursor === null ? "schedule" : "continuation",
                  requestedCursor,
                });
              },
            );
            if (due === null || due.status !== "queued") return;
            await profileSyncScheduler.start({
              organizationId: scope.organizationId,
              workspaceId: scope.workspaceId,
              websiteProjectId: scope.websiteProjectId,
              profileSyncJobId: due.jobId,
              canonicalDomain: due.canonicalDomain,
            });
          });
          nextBacklinkProfileScanAt = Date.now() + 15_000;
        } else if (
          workerAuthority !== null &&
          dataForSeoAvailable &&
          dataForSeoConfiguration !== null &&
          automaticProfileSync &&
          projectRecommendationWorkPending &&
          Date.now() >= nextBacklinkProfileScanAt
        ) {
          console.log(
            JSON.stringify({
              event: "backlinks.backlink-profile.deferred",
              reason: "project_recommendation_work_pending",
            }),
          );
          nextBacklinkProfileScanAt = Date.now() + 15_000;
        }
        if (contactEnrichmentRelay !== null) {
          if (Date.now() >= nextContactScanAt) {
            const scopes = await listContactEnrichmentRecoveryScopes(
              context.pool,
              100,
            );
            for (const scope of scopes) {
              const state = await withBacklinkTenantTransaction(
                pool,
                scope,
                async (client) => {
                  const recovery =
                    await recoverRecommendationPoolV2CanonicalBatchPreparation(
                      client,
                      contactEnrichmentOptions,
                      { ...scope, actorId: workerId },
                    );
                  const created = await ensureReadyContactEnrichmentJobs(
                    client,
                    {
                      scope,
                      actorId: workerId,
                      limit: maxConcurrentContactEnrichmentJobs,
                      options: contactEnrichmentOptions,
                      createNewJobs:
                        recovery.status === "contract_not_applicable",
                    },
                  );
                  return Object.freeze({ created, recovery });
                },
              );
              if (state.created > 0) {
                console.log(
                  JSON.stringify({
                    event: "backlinks.contact-enrichment.jobs.recovered",
                    ...scope,
                    created: state.created,
                  }),
                );
              }
            }
            nextContactScanAt = Date.now() + 5_000;
          }
          const contactOutcome = await contactEnrichmentRelay.runOnce({
            workerId,
            limit: maxConcurrentContactEnrichmentJobs,
            staleClaimBefore,
          });
          if (contactOutcome.claimed > 0) {
            console.log(
              JSON.stringify({
                event: "backlinks.contact-enrichment.outbox.relay",
                ...contactOutcome,
              }),
            );
          }
        } else {
          const shouldEnsureContacts = Date.now() >= nextContactScanAt;
          const contactScopes: Array<
            Readonly<{
              scope: ActiveProjectScope;
              activeCount: number;
              contextCreatedAtEpoch: number;
            }>
          > = [];
          await runLocalProjectLane("contact-enrichment", async (scope) => {
            const state = await withBacklinkTenantTransaction(
              pool,
              scope,
              async (client) => {
                const recommendationPoolV2Recovery =
                  shouldEnsureContacts && workerAuthority !== null
                    ? await recoverRecommendationPoolV2CanonicalBatchPreparation(
                        client,
                        contactEnrichmentOptions,
                        { ...scope, actorId: workerAuthority.actorId },
                      )
                    : null;
                const created =
                  shouldEnsureContacts && workerAuthority !== null
                    ? await ensureReadyContactEnrichmentJobs(client, {
                        scope,
                        actorId: workerAuthority.actorId,
                        limit: maxConcurrentContactEnrichmentJobs,
                        options: contactEnrichmentOptions,
                        createNewJobs:
                          recommendationPoolV2Recovery?.status ===
                          "contract_not_applicable",
                      })
                    : 0;
                const priority = await client.query(
                  `
                  SELECT
                    EXTRACT(EPOCH FROM context.created_at)::double precision
                      "contextCreatedAtEpoch",
                    (
                      SELECT count(*)::integer
                        FROM backlink_contact_enrichment_jobs job
                       WHERE (
                         job.organization_id,
                         job.workspace_id,
                         job.website_project_id
                       )=($1,$2,$3)
                         AND (
                           job.status='running'
                           OR (
                             job.status IN ('pending','retry_scheduled')
                             AND EXISTS (
                               SELECT 1
                                 FROM backlink_outbox_events event
                                WHERE (
                                  event.organization_id,
                                  event.workspace_id,
                                  event.website_project_id
                                )=(
                                  job.organization_id,
                                  job.workspace_id,
                                  job.website_project_id
                                )
                                  AND event.event_type=
                                    'backlinks.contact-enrichment.requested.v1'
                                  AND event.aggregate_id=job.id
                                  AND event.aggregate_version=job.version
                                  AND event.status='published'
                             )
                           )
                         )
                    ) "activeCount"
                    FROM backlink_project_context_snapshots context
                   WHERE (
                     context.organization_id,context.workspace_id,
                     context.website_project_id,context.id
                   )=($1,$2,$3,$4)
                `,
                  [
                    scope.organizationId,
                    scope.workspaceId,
                    scope.websiteProjectId,
                    scope.projectContextSnapshotId,
                  ],
                );
                return Object.freeze({
                  created,
                  recommendationPoolV2Recovery,
                  activeCount: Number(priority.rows[0]?.activeCount ?? 0),
                  contextCreatedAtEpoch: Number(
                    priority.rows[0]?.contextCreatedAtEpoch ?? 0,
                  ),
                });
              },
            );
            if (state.created > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.contact-enrichment.jobs.ensured",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  created: state.created,
                }),
              );
            }
            contactScopes.push(
              Object.freeze({
                scope,
                activeCount: state.activeCount,
                contextCreatedAtEpoch: state.contextCreatedAtEpoch,
              }),
            );
          });
          contactScopes.sort(
            (left, right) =>
              right.contextCreatedAtEpoch - left.contextCreatedAtEpoch ||
              left.scope.websiteProjectId.localeCompare(
                right.scope.websiteProjectId,
              ),
          );
          let availableContactSlots = Math.max(
            0,
            maxConcurrentContactEnrichmentJobs -
              contactScopes.reduce(
                (total, candidate) => total + candidate.activeCount,
                0,
              ),
          );
          for (const candidate of contactScopes) {
            if (availableContactSlots <= 0) break;
            const scope = candidate.scope;
            const outcome = await createContactEnrichmentOutboxRelay({
              repository: createScopedOutboxRelayRepository(pool, scope),
              consumer: contactEnrichmentConsumer,
            }).runOnce({
              workerId: scopedWorkerId(scope, "contact-enrichment"),
              limit: 1,
              staleClaimBefore,
            });
            availableContactSlots = Math.max(
              0,
              availableContactSlots - outcome.claimed,
            );
            if (outcome.claimed > 0) {
              console.log(
                JSON.stringify({
                  event: "backlinks.contact-enrichment.outbox.relay",
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  ...outcome,
                }),
              );
            }
          }
          if (shouldEnsureContacts) {
            nextContactScanAt = Date.now() + 5_000;
          }
        }
        if (gmailSendRuntime !== null) {
          if (Date.now() >= nextGmailSendRecoveryAt) {
            await runLocalProjectLane("gmail-sync", async (scope) => {
              if (workerAuthority === null) return;
              const projectContext = await createWorkerProjectContext(
                pool,
                scope,
                workerAuthority.actorId,
              );
              if (projectContext === null) return;
              const recovered = await gmailSendRuntime.recoverStaleSends({
                context: projectContext,
                staleBefore: new Date(Date.now() - 5 * 60_000),
                limit: 10,
              });
              if (recovered > 0) {
                console.log(
                  JSON.stringify({
                    event: "backlinks.gmail-send.recovery.scheduled",
                    organizationId: scope.organizationId,
                    workspaceId: scope.workspaceId,
                    websiteProjectId: scope.websiteProjectId,
                    recovered,
                  }),
                );
              }
            });
            nextGmailSendRecoveryAt = Date.now() + 60_000;
          }
          if (Date.now() >= nextGmailTokenHealthCheckAt) {
            const checkedConnections = new Set<string>();
            await runLocalProjectLane("gmail-sync", async (scope) => {
              if (workerAuthority === null) return;
              const projectContext = await createWorkerProjectContext(
                pool,
                scope,
                workerAuthority.actorId,
              );
              if (projectContext === null) return;
              const connection =
                await gmailSendRuntime.findSelectedConnection(projectContext);
              if (connection === null) return;
              const connectionKey = [
                scope.organizationId,
                connection.connectionId,
              ].join(":");
              if (checkedConnections.has(connectionKey)) return;
              checkedConnections.add(connectionKey);
              const now = Date.now();
              const retryState =
                gmailTokenHealthRetryByConnection.get(connectionKey);
              if (retryState !== undefined && retryState.nextAttemptAt > now)
                return;
              try {
                const result = await gmailSendRuntime.refreshTokenHealth({
                  context: projectContext,
                  connectionId: connection.connectionId,
                  expectedVersion: connection.version,
                });
                const nextAttemptAt = Date.now() + 86_400_000;
                gmailTokenHealthRetryByConnection.set(connectionKey, {
                  consecutiveFailures: 0,
                  nextAttemptAt,
                });
                console.log(
                  JSON.stringify({
                    event: "backlinks.gmail-token-health.checked",
                    organizationId: scope.organizationId,
                    workspaceId: scope.workspaceId,
                    connectionId: connection.connectionId,
                    outcome: result.outcome,
                    connectionStatus: result.connection.connectionStatus,
                    recentErrorCategory:
                      result.connection.recentErrorCategory ?? null,
                    nextAttemptAt: new Date(nextAttemptAt).toISOString(),
                  }),
                );
              } catch (error) {
                const consecutiveFailures =
                  (retryState?.consecutiveFailures ?? 0) + 1;
                const retryDelaySeconds =
                  calculateGmailTokenHealthRetryDelaySeconds(
                    consecutiveFailures,
                  );
                const nextAttemptAt = Date.now() + retryDelaySeconds * 1_000;
                gmailTokenHealthRetryByConnection.set(connectionKey, {
                  consecutiveFailures,
                  nextAttemptAt,
                });
                const authError =
                  error instanceof GoogleAuthError ? error : null;
                const errorCategory =
                  authError?.code ??
                  (typeof error === "object" &&
                  error !== null &&
                  "code" in error
                    ? String(error.code)
                    : "UNKNOWN");
                console.error(
                  JSON.stringify({
                    event: "backlinks.gmail-token-health.failed",
                    organizationId: scope.organizationId,
                    workspaceId: scope.workspaceId,
                    connectionId: connection.connectionId,
                    errorCategory,
                    httpStatus: authError?.httpStatus ?? null,
                    providerRequestId: authError?.providerRequestId ?? null,
                    transportCode: authError?.transportCode ?? null,
                    consecutiveFailures,
                    nextAttemptAt: new Date(nextAttemptAt).toISOString(),
                  }),
                );
              }
            });
            nextGmailTokenHealthCheckAt = Date.now() + 60_000;
          }
          const gmailOutcome = await gmailSendRuntime.relay.runOnce({
            workerId,
            limit: 1,
            staleClaimBefore: new Date(Date.now() - 30_000),
          });
          if (gmailOutcome.claimed > 0) {
            console.log(
              JSON.stringify({
                event: "backlinks.gmail-send.outbox.relay",
                ...gmailOutcome,
              }),
            );
          }
        }
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "backlinks.outbox.relay.failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  };
  const activities = Object.freeze({
    backlinksRunContactEnrichmentV1: contactEnrichmentActivity,
    backlinksLoadRecommendationPoolV2Generation:
      recommendationPoolV2Activities.loadGeneration,
    backlinksExecuteRecommendationPoolV2DiscoveryRound:
      recommendationPoolV2Activities.executeDiscoveryRound,
    backlinksFinalizeRecommendationPoolV2Generation:
      recommendationPoolV2Activities.finalizeGeneration,
    backlinksPrepareRecommendationPoolV2CanonicalBatches:
      recommendationPoolV2Activities.prepareCanonicalBatches,
    backlinksInspectRecommendationPoolV2CanonicalBatchPreparation:
      recommendationPoolV2Activities.inspectCanonicalBatchPreparation,
    backlinksConvergeRecommendationPoolV2CanonicalBatchPreparation:
      recommendationPoolV2Activities.convergeCanonicalBatchPreparation,
    backlinksActivateRecommendationPoolV2Generation:
      recommendationPoolV2Activities.activateGeneration,
    backlinksCompleteRecommendationPoolV2GenerationWithoutPublication:
      recommendationPoolV2Activities.completeGenerationWithoutPublication,
    backlinksFailRecommendationPoolV2Generation:
      recommendationPoolV2Activities.failGeneration,
    backlinksCompleteRecommendationPoolV2GenerationSupersession:
      recommendationPoolV2Activities.completeGenerationSupersession,
    backlinksRecoverRecommendationPoolV2CanonicalBatchPreparation:
      recommendationPoolV2Phase4Activities.recoverCanonicalBatchPreparation,
    async backlinksLoadProjectAnalysisContextV1(
      input: Readonly<{
        organizationId: string;
        workspaceId: string;
        websiteProjectId: string;
        jobId: string;
        workflowId: string;
        snapshotVersion: number;
      }>,
    ) {
      const scope = tenantScopeFrom(input);
      return withBacklinkTenantTransaction(pool, scope, async (client) => {
        return createBacklinkProjectAnalysisActivities(
          createProjectContextSnapshotRepository(client),
          undefined,
          createProjectAnalysisJobWriter(client),
          undefined,
        ).loadBacklinkProjectAnalysisContext(input);
      });
    },
    async backlinksRunDraftGenerationV1(
      input: Parameters<typeof runDraftGenerationWorkflow>[0],
    ) {
      if (input.generationMode !== "MODEL" || aiRuntime === null) {
        return runDraftGenerationWorkflow(
          input,
          draftGenerationRepository,
          null,
        );
      }
      let reservation: "active" | "terminal" | null = null;
      const draft = aiRuntime.draft(input);
      try {
        const result = await runDraftGenerationWorkflow(
          input,
          draftGenerationRepository,
          {
            async generate(prompt) {
              if (reservation === null) {
                reservation = await aiRuntime.reserve(input);
              }
              return draft.generate(prompt);
            },
          },
        );
        if (
          reservation === "active" &&
          (result.outcome === "completed" ||
            result.outcome === "already_completed")
        ) {
          await aiRuntime.settle(input);
        } else if (
          reservation === "active" &&
          (result.outcome === "failed" ||
            result.outcome === "completed_with_basic_draft")
        ) {
          await aiRuntime.release(input);
        }
        return result;
      } catch (error) {
        if (reservation === "active") {
          await aiRuntime.release(input);
        }
        throw error;
      }
    },

    async backlinksRunProfileSyncV1(
      input: Parameters<
        ReturnType<typeof createLocalProductBacklinkProfileRuntime>["execute"]
      >[0],
    ) {
      if (backlinkProfileRuntime === null) {
        return markBacklinkProfileInputRequired(pool, input);
      }
      return backlinkProfileRuntime.execute(input);
    },

    backlinksRunPlacementInitialValidationV1:
      placementActivities.backlinksRunPlacementInitialValidationV1,
    backlinksRunPlacementMonitoringV1:
      placementActivities.backlinksRunPlacementMonitoringV1,
    async backlinksInitializePlacementMonitoringV1(
      input: PlacementMonitoringInitializationWorkflowInput,
    ): Promise<PlacementMonitoringInitializationResult> {
      const scope = tenantScopeFrom(input);
      return withBacklinkTenantTransaction(pool, scope, async (client) => {
        const inserted = await client.query(
          `WITH source AS (
               SELECT event.id
                 FROM backlink_outbox_events AS event
                WHERE event.organization_id=$1
                  AND event.workspace_id=$2
                  AND event.website_project_id=$3
                  AND event.id=$4
                  AND event.event_type=
                    'backlinks.placement-monitoring.requested.v1'
             ), placement AS (
               SELECT fact.id
                 FROM backlink_placements AS fact
                WHERE fact.organization_id=$1
                  AND fact.workspace_id=$2
                  AND fact.website_project_id=$3
                  AND fact.id=$5
             )
             INSERT INTO backlink_monitor_policies (
               id,organization_id,workspace_id,website_project_id,
               placement_id,policy_version,normal_interval_seconds,
               suspected_recheck_interval_seconds,jitter_window_seconds,
               retry_initial_delay_seconds,retry_max_delay_seconds,
               retry_backoff_multiplier,max_retry_attempts,
               loss_confirmation_count,change_confirmation_count,
               browser_fallback_enabled,next_check_at,schema_version,
               version,source_outbox_event_id,workflow_id,
               created_by,updated_by
             )
             SELECT $6,$1,$2,$3,$5,'placement-monitoring-policy.v1',
                    $10::integer,$11::integer,$12::integer,
                    60,3600,2,3,2,2,$13::boolean,
                    $7::timestamptz,1,1,$4,$8,$9,$9
               FROM source CROSS JOIN placement
             ON CONFLICT (
               organization_id,workspace_id,website_project_id,
               placement_id,policy_version
             ) DO NOTHING
             RETURNING id AS "projectionId",
                       policy_version AS "policyVersion",
                       next_check_at AS "nextCheckAt"`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.sourceOutboxEventId,
            input.placementId,
            input.projectionId,
            input.requestedAt,
            input.workflowId,
            input.workerId,
            placementMonitoringConfiguration.normalIntervalSeconds,
            placementMonitoringConfiguration.suspectedRecheckIntervalSeconds,
            placementMonitoringConfiguration.jitterWindowSeconds,
            browserProviderAvailable,
          ],
        );
        const created = inserted.rows[0];
        if (created !== undefined) {
          return {
            placementId: input.placementId,
            sourceOutboxEventId: input.sourceOutboxEventId,
            projectionId: String(created.projectionId),
            workflowId: input.workflowId,
            policyVersion: String(created.policyVersion),
            nextCheckAt: new Date(String(created.nextCheckAt)).toISOString(),
            state: "created",
          };
        }
        const existing = await client.query(
          `SELECT id AS "projectionId",
                    source_outbox_event_id AS "sourceOutboxEventId",
                    workflow_id AS "workflowId",
                    policy_version AS "policyVersion",
                    next_check_at AS "nextCheckAt"
               FROM backlink_monitor_policies
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND placement_id=$4
                AND policy_version='placement-monitoring-policy.v1'`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.placementId,
          ],
        );
        const row = existing.rows[0];
        if (
          row === undefined ||
          row.projectionId !== input.projectionId ||
          row.sourceOutboxEventId !== input.sourceOutboxEventId ||
          row.workflowId !== input.workflowId
        ) {
          throw new Error("BACKLINK_PLACEMENT_MONITORING_PROJECTION_CONFLICT");
        }
        return {
          placementId: input.placementId,
          sourceOutboxEventId: input.sourceOutboxEventId,
          projectionId: String(row.projectionId),
          workflowId: String(row.workflowId),
          policyVersion: String(row.policyVersion),
          nextCheckAt: new Date(String(row.nextCheckAt)).toISOString(),
          state: "existing",
        };
      });
    },
    ...(gmailSendRuntime === null
      ? {}
      : {
          backlinksClaimGmailSendAttemptV1: (
            input: Parameters<typeof gmailSendRuntime.activity.claimAttempt>[0],
          ) => gmailSendRuntime.activity.claimAttempt(input),
          backlinksDispatchGmailSendAttemptV1: (
            input: Parameters<
              typeof gmailSendRuntime.activity.dispatchAttempt
            >[0],
          ) => gmailSendRuntime.activity.dispatchAttempt(input),
          backlinksSettleGmailSendAttemptV1: (
            input: Parameters<
              typeof gmailSendRuntime.activity.settleAttempt
            >[0],
          ) => gmailSendRuntime.activity.settleAttempt(input),
          backlinksLoadGmailSendReconciliationV1: (
            input: Parameters<
              typeof gmailSendRuntime.reconciliationActivity.load
            >[0],
          ) => gmailSendRuntime.reconciliationActivity.load(input),
          backlinksQueryGmailSentMessageV1: (
            input: Parameters<
              typeof gmailSendRuntime.reconciliationActivity.query
            >[0],
          ) => gmailSendRuntime.reconciliationActivity.query(input),
          backlinksRecoverGmailDispatchV1: (
            input: Parameters<
              typeof gmailSendRuntime.reconciliationActivity.recoverDispatch
            >[0],
          ) => gmailSendRuntime.reconciliationActivity.recoverDispatch(input),
          backlinksReconcileGmailSendResultV1: (
            input: Parameters<
              typeof gmailSendRuntime.reconciliationActivity.reconcile
            >[0],
          ) => gmailSendRuntime.reconciliationActivity.reconcile(input),
        }),
    backlinksRunGmailPollingSyncV1: (input: GmailPollingSyncWorkflowInput) =>
      gmailSyncRuntime === null
        ? Promise.resolve(createGmailPollingSyncCapabilityPausedResult(input))
        : gmailSyncRuntime.run(input),
  });

  return Object.freeze({
    workflowsPath: fileURLToPath(
      new URL(
        "../workflows/definitions/index.js",
        import.meta.url,
      ),
    ),
    activities: activities,

    healthSnapshot: async () => {
      const staleBefore = projectAnalysisStaleBefore();
      let tasks: ProjectTaskHealth;
      if (projectAnalysisRecovery !== null) {
        tasks = await projectAnalysisRecovery.health(staleBefore);
      } else if (workerAuthority !== null && projectScopeProvider !== null) {
        const snapshots: ProjectTaskHealth[] = [];
        const outcome = await runProjectScopedLane({
          provider: projectScopeProvider,
          organizationId: workerAuthority.organizationId,
          workspaceId: workerAuthority.workspaceId,
          lane: "project-analysis",
          pageLimit: 25,
          run: async (scope) => {
            snapshots.push(
              await withBacklinkTenantTransaction(pool, scope, (client) =>
                createScopedProjectAnalysisRecovery(client).health(staleBefore),
              ),
            );
          },
          onProjectError: (scope, error) =>
            logProjectFailure("project-analysis", scope, error),
        });
        if (outcome.failed > 0) {
          throw new Error("BACKLINK_PROJECT_TASK_HEALTH_PARTIAL");
        }
        tasks = combineProjectTaskHealth(snapshots);
      } else {
        tasks = combineProjectTaskHealth([]);
      }
      return { status: "ok", ...tasks };
    },
    backgroundServices: Object.freeze([
          Object.freeze({
            async start() {
              if (relayTimer !== undefined) return;
              runRelay();
              relayTimer = setInterval(runRelay, 500);
            },
            async stop() {
              if (relayTimer !== undefined) {
                clearInterval(relayTimer);
                relayTimer = undefined;
              }
              await relayRun;
            },
          }),
        ]),
  });
}

let closed = false;

export const runtime: BacklinksProductionRuntimeModule = Object.freeze({
  async createApiDependencies(context) {
    if (closed) {
      throw new Error("BACKLINKS_RUNTIME_ALREADY_CLOSED");
    }
    return createApiDependencies(context);
  },
  async createWorkerRegistrations(context) {
    if (closed) {
      throw new Error("BACKLINKS_RUNTIME_ALREADY_CLOSED");
    }
    return createWorkerRegistrations(context);
  },
  async close() {
    closed = true;
  },
});

export default runtime;
