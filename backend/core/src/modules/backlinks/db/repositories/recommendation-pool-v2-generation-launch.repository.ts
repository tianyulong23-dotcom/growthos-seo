import { createHash, randomUUID } from "node:crypto";
import { resolveDataForSeoProjectLocale } from "../../adapters/dataforseo/project-locale.js";

import type { ProviderOperationBudgetAuthorization } from "../../domain/recommendations/provider-operation-budget.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import { isRecommendationPoolV2ProjectGeneratable } from "../../domain/recommendations/recommendation-pool-v2-project-generation-eligibility.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";
import { createRecommendationPoolV2TimingRepository } from "./recommendation-pool-v2-timing.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../tenant-transaction.js";

export type RecommendationPoolV2GenerationLaunch = Readonly<{
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  jobId: string;
  workflowId: string;
  replayed: boolean;
}>;

export type RecommendationPoolV2ConfirmedGenerationLaunch =
  RecommendationPoolV2GenerationLaunch &
    Readonly<{
      seedFingerprints: readonly string[];
    }>;

export type RecommendationPoolV2GenerationLaunchRepository = Readonly<{
  stage(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      actorId: string;
      requestId: string;
      idempotencyKey: string;
      providerBudgetAuthorization: ProviderOperationBudgetAuthorization;
    }>,
  ): Promise<RecommendationPoolV2GenerationLaunch>;
  confirmLaunch(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      actorId: string;
      generationContractId: string;
      seedSnapshotFingerprint: string;
      idempotencyKey: string;
    }>,
  ): Promise<RecommendationPoolV2ConfirmedGenerationLaunch>;
}>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function conflict(message: string): never {
  throw new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function mapLaunch(
  row: Record<string, unknown>,
  replayed: boolean,
): RecommendationPoolV2GenerationLaunch {
  return Object.freeze({
    generationContractId: String(row.generationContractId),
    recommendationContextVersionId: String(row.recommendationContextVersionId),
    visiblePoolGeneration: Number(row.visiblePoolGeneration),
    inputPinId: String(row.inputPinId),
    jobId: String(row.jobId),
    workflowId: String(row.workflowId),
    replayed,
  });
}

export function createRecommendationPoolV2GenerationLaunchRepository(
  pool: BacklinkTenantPool,
): RecommendationPoolV2GenerationLaunchRepository {
  return Object.freeze({
    stage(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const launchIdempotencyHash = hash({
          contract: "recommendation-pool-v2-generation-launch.v1",
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          idempotencyKey: input.idempotencyKey,
        });
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            [
              "recommendation-pool-v2-generation-launch.v1",
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
            ].join(":"),
          ],
        );

        const currentResult = await client.query(
          `SELECT contract.generation_contract_id
                    "generationContractId",
                  contract.recommendation_context_version_id
                    "recommendationContextVersionId",
                  contract.visible_pool_generation "visiblePoolGeneration",
                  contract.input_pin_id "inputPinId",
                  contract.pool_contract_version "poolContractVersion",
                  contract.migration_state "migrationState",
                  contract.state_reason_codes "stateReasonCodes",
                  CASE
                    WHEN contract.migration_state='MIGRATION_BLOCKED'
                      THEN COALESCE((
                        backlinks
                          .backlink_recommendation_pool_v2_native_generation_verify()
                          ->>'v1WritesFrozen'
                      )::boolean,false)
                    ELSE false
                  END "v1WritesFrozen",
                  generation.qualification_contract_version
                    "qualificationContractVersion",
                  generation.visibility_contract_version
                    "visibilityContractVersion",
                  generation.score_model_version "scoreModelVersion",
                  generation.metric_scope "metricScope",
                  generation.market,generation.location,generation.language,
                  generation.traffic_location_code "trafficLocationCode",
                  generation.traffic_language_code "trafficLanguageCode",
                  generation.request_fingerprints "requestFingerprints",
                  generation.creator_worker_contract_version
                    "creatorWorkerContractVersion",
                  generation.seed_contract_version "seedContractVersion",
                  generation.release_contract_version
                    "releaseContractVersion",
                  generation.recommendation_marker_version
                    "recommendationMarkerVersion",
                  generation.discovery_budget_policy_version
                     "discoveryBudgetPolicyVersion",
                  pin.project_context_version "projectContextVersion",
                  pin.site_profile_version_id "siteProfileVersionId",
                  pin.outreach_profile_version_id "outreachProfileVersionId",
                  pin.promotion_target_version_id "promotionTargetVersionId",
                  pin.keyword_evidence_snapshot_ids
                    "keywordEvidenceSnapshotIds",
                  pin.shared_evidence_snapshot_ids
                    "sharedEvidenceSnapshotIds",
                  pin.market "inputPinMarket",
                  latest.id "authoritativeContextId",
                  (
                    SELECT max(candidate.visible_pool_generation)
                      FROM backlinks.backlink_recommendation_generation_contracts
                        AS candidate
                     WHERE candidate.organization_id=contract.organization_id
                       AND candidate.workspace_id=contract.workspace_id
                       AND candidate.website_project_id=
                             contract.website_project_id
                  ) "maximumVisiblePoolGeneration"
             FROM backlinks.backlink_recommendation_pool_project_contracts
               AS contract
             JOIN backlinks.backlink_recommendation_generation_contracts
               AS generation
               ON generation.organization_id=contract.organization_id
              AND generation.workspace_id=contract.workspace_id
              AND generation.website_project_id=contract.website_project_id
              AND generation.id=contract.generation_contract_id
             JOIN backlinks.backlink_generation_input_pins AS pin
               ON pin.organization_id=generation.organization_id
              AND pin.workspace_id=generation.workspace_id
              AND pin.website_project_id=generation.website_project_id
              AND pin.id=generation.input_pin_id
             JOIN LATERAL (
               SELECT snapshot.id
                 FROM backlinks.backlink_project_context_snapshots AS snapshot
                WHERE snapshot.organization_id=contract.organization_id
                  AND snapshot.workspace_id=contract.workspace_id
                  AND snapshot.website_project_id=contract.website_project_id
                ORDER BY snapshot.snapshot_version DESC
                LIMIT 1
             ) AS latest ON true
            WHERE contract.organization_id=$1 AND contract.workspace_id=$2
              AND contract.website_project_id=$3
            FOR UPDATE OF contract`,
          [input.organizationId, input.workspaceId, input.websiteProjectId],
        );
        let current = currentResult.rows[0];
        if (current === undefined) {
          const initial = await client.query(
            `SELECT contract.pool_contract_version "poolContractVersion",
                    contract.migration_state "migrationState",
                    latest.id "recommendationContextVersionId",
                    latest.id "authoritativeContextId",
                    latest.country_code "countryCode",latest.locale,
                    pin.project_context_version "projectContextVersion",
                    pin.site_profile_version_id "siteProfileVersionId",
                    pin.outreach_profile_version_id "outreachProfileVersionId",
                    pin.promotion_target_version_id "promotionTargetVersionId",
                    pin.keyword_evidence_snapshot_ids "keywordEvidenceSnapshotIds",
                    pin.shared_evidence_snapshot_ids "sharedEvidenceSnapshotIds",
                    pin.market "inputPinMarket",
                    (SELECT COALESCE(max(generation.visible_pool_generation),0)
                       FROM backlinks.backlink_recommendation_generation_contracts generation
                      WHERE generation.organization_id=contract.organization_id
                        AND generation.workspace_id=contract.workspace_id
                        AND generation.website_project_id=contract.website_project_id
                    ) "maximumVisiblePoolGeneration"
               FROM backlinks.backlink_recommendation_pool_project_contracts contract
               JOIN LATERAL (
                 SELECT snapshot.*
                   FROM backlinks.backlink_project_context_snapshots snapshot
                  WHERE snapshot.organization_id=contract.organization_id
                    AND snapshot.workspace_id=contract.workspace_id
                    AND snapshot.website_project_id=contract.website_project_id
                  ORDER BY snapshot.snapshot_version DESC LIMIT 1
               ) latest ON latest.project_status='ACTIVE'
               JOIN LATERAL (
                 SELECT candidate.*
                   FROM backlinks.backlink_generation_input_pins candidate
                  WHERE candidate.organization_id=contract.organization_id
                    AND candidate.workspace_id=contract.workspace_id
                    AND candidate.website_project_id=contract.website_project_id
                    AND candidate.project_context_version=latest.snapshot_version
                    AND candidate.qualification_contract_version='recommendation-pool-admission.v2'
                  ORDER BY candidate.created_at DESC,candidate.id LIMIT 1
               ) pin ON true
              WHERE contract.organization_id=$1 AND contract.workspace_id=$2
                AND contract.website_project_id=$3
                AND contract.pool_contract_version='recommendation-pool.v2'
                AND contract.migration_state='V2_READY'
                AND contract.generation_contract_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM backlinks.backlink_recommendation_generation_contracts generation
                   WHERE generation.organization_id=contract.organization_id
                     AND generation.workspace_id=contract.workspace_id
                     AND generation.website_project_id=contract.website_project_id
                     AND generation.pool_contract_version <> 'recommendation-pool.v2'
                )
              FOR UPDATE OF contract`,
            [input.organizationId, input.workspaceId, input.websiteProjectId],
          );
          const first = initial.rows[0];
          if (first !== undefined) {
            const locale = resolveDataForSeoProjectLocale({
              countryCode: String(first.countryCode),
              locale: String(first.locale),
            });
            current = {
              ...first,
              metricScope: "TARGET_MARKET",
              market: first.inputPinMarket,
              location: locale.countryCode,
              language: locale.languageCode,
              trafficLocationCode: Number(locale.locationCode),
              trafficLanguageCode: locale.languageCode,
              releaseContractVersion: "recommendation-release.v2",
              recommendationMarkerVersion: "recommendation-marker.v2",
              discoveryBudgetPolicyVersion: "recommendation-discovery-budget.v1",
            };
          }
        }
        if (
          current === undefined ||
          !isRecommendationPoolV2ProjectGeneratable(current)
        ) {
          throw new Error("RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE");
        }
        if (
          String(current.recommendationContextVersionId) !==
          String(current.authoritativeContextId)
        ) {
          throw new Error("RECOMMENDATION_POOL_V2_CONTEXT_SUPERSEDED");
        }

        await client.query(
          `WITH terminal_jobs AS MATERIALIZED (
             SELECT job.id "jobId",fact.id "terminalFactId",
                    fact.terminal_reason "terminalReason",
                    fact.effective_unique_candidate_count
                      "effectiveUniqueCandidateCount",
                    fact.total_settled_cost_micros "totalSettledCostMicros"
               FROM backlinks.backlink_jobs AS job
               JOIN backlinks
                 .backlink_recommendation_discovery_generation_terminal_facts
                 AS fact
                 ON fact.organization_id=job.organization_id
                AND fact.workspace_id=job.workspace_id
                AND fact.website_project_id=job.website_project_id
                AND fact.generation_contract_id=CASE
                  WHEN job.result_summary->>'generationContractId' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (
                    job.result_summary->>'generationContractId'
                  )::uuid
                  ELSE NULL
                END
               JOIN backlinks.backlink_recommendation_generation_contracts
                 AS generation
                 ON generation.organization_id=fact.organization_id
                AND generation.workspace_id=fact.workspace_id
                AND generation.website_project_id=fact.website_project_id
                AND generation.id=fact.generation_contract_id
                AND generation.recommendation_context_version_id=
                      fact.recommendation_context_version_id
                AND generation.visible_pool_generation=
                      fact.visible_pool_generation
                AND generation.input_pin_id=fact.input_pin_id
                AND generation.pool_contract_version=fact.pool_contract_version
              WHERE job.organization_id=$1 AND job.workspace_id=$2
                AND job.website_project_id=$3
                AND job.job_type='recommendation_pool_v2_generation'
                AND job.source_object_type='project-context-snapshot'
                AND job.source_object_id=$4
                AND job.status IN ('queued','running','waiting_provider')
                AND fact.pool_contract_version='recommendation-pool.v2'
                AND fact.effective_unique_candidate_count=0
                AND generation.effective_unique_candidate_count=0
                AND generation.discovery_terminal_reason=fact.terminal_reason
           )
           UPDATE backlinks.backlink_jobs AS job
              SET status='success',
                  step='completed_no_valid_candidates',
                  progress=100,
                  finished_at=COALESCE(
                    job.finished_at,
                    statement_timestamp()
                  ),
                  result_summary=(
                    COALESCE(job.result_summary,'{}'::jsonb)
                    - 'failureCode'
                    - 'failureMessage'
                    - 'failureRetryable'
                  ) ||
                    jsonb_build_object(
                      'final',true,
                      'outcome','NO_VALID_CANDIDATES_AFTER_EXHAUSTION',
                      'terminalReason',
                        'NO_VALID_CANDIDATES_AFTER_EXHAUSTION',
                      'discoveryTerminalReason',terminal."terminalReason",
                      'effectiveUniqueCandidateCount',
                        terminal."effectiveUniqueCandidateCount",
                      'admittedCount',0,
                      'releasedCount',0,
                      'releaseResult','NO_BATCH',
                      'totalSettledCostMicros',
                        terminal."totalSettledCostMicros",
                      'terminalFactId',terminal."terminalFactId"::text,
                      'reconciledFromTerminalFact',true
                    ),
                  error=NULL,
                  updated_at=statement_timestamp(),updated_by=$5,
                  version=job.version+1
             FROM terminal_jobs AS terminal
            WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3
              AND job.id=terminal."jobId"`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.recommendationContextVersionId,
            input.actorId,
          ],
        );

        await client.query(
          `WITH incompatible_active_jobs AS MATERIALIZED (
             SELECT job.id
               FROM backlinks.backlink_jobs AS job
               JOIN backlinks.backlink_recommendation_generation_contracts
                 AS generation
                 ON generation.organization_id=job.organization_id
                AND generation.workspace_id=job.workspace_id
                AND generation.website_project_id=job.website_project_id
                AND generation.id=CASE
                  WHEN job.result_summary->>'generationContractId' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (
                    job.result_summary->>'generationContractId'
                  )::uuid
                  ELSE NULL
                END
              WHERE job.organization_id=$1 AND job.workspace_id=$2
                AND job.website_project_id=$3
                AND job.job_type='recommendation_pool_v2_generation'
                AND job.source_object_type='project-context-snapshot'
                AND job.source_object_id=$4
                AND job.status IN ('queued','running','waiting_provider')
                AND generation.pool_contract_version='recommendation-pool.v2'
                AND (
                  EXISTS (
                    SELECT 1
                      FROM backlinks
                        .backlink_recommendation_discovery_request_intents
                        AS intent
                     WHERE intent.organization_id=generation.organization_id
                       AND intent.workspace_id=generation.workspace_id
                       AND intent.website_project_id=
                             generation.website_project_id
                       AND intent.generation_contract_id=generation.id
                       AND intent.discovery_window_ordinal<
                             intent.round_number
                  )
                  OR EXISTS (
                    SELECT 1
                      FROM backlinks
                        .backlink_recommendation_discovery_window_facts
                        AS window_fact
                     WHERE window_fact.organization_id=
                             generation.organization_id
                       AND window_fact.workspace_id=generation.workspace_id
                       AND window_fact.website_project_id=
                             generation.website_project_id
                       AND window_fact.generation_contract_id=generation.id
                       AND window_fact.window_ordinal<
                             window_fact.round_number
                  )
                )
           )
           UPDATE backlinks.backlink_jobs AS job
              SET status='failed',
                  step='non_resumable_discovery_lineage',
                  progress=100,
                  finished_at=COALESCE(
                    job.finished_at,
                    statement_timestamp()
                  ),
                  result_summary=
                    COALESCE(job.result_summary,'{}'::jsonb) ||
                    jsonb_build_object(
                      'outcome','RESTART_REQUIRED',
                      'nonResumableDiscoveryLineage',true
                    ),
                  error=jsonb_build_object(
                    'code',
                      'RECOMMENDATION_POOL_V2_DISCOVERY_LINEAGE_INCOMPATIBLE',
                    'message',
                      'Completed discovery facts require a new generation.'
                  ),
                  updated_at=statement_timestamp(),updated_by=$5,
                  version=job.version+1
             FROM incompatible_active_jobs AS incompatible
            WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3
              AND job.id=incompatible.id`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.recommendationContextVersionId,
            input.actorId,
          ],
        );

        const replayResult = await client.query(
          `SELECT generation.id "generationContractId",
                  generation.recommendation_context_version_id
                    "recommendationContextVersionId",
                  generation.visible_pool_generation
                    "visiblePoolGeneration",
                  generation.input_pin_id "inputPinId",
                  job.id "jobId",job.workflow_id "workflowId"
             FROM backlinks.backlink_jobs AS job
             JOIN backlinks.backlink_recommendation_generation_contracts
               AS generation
               ON generation.organization_id=job.organization_id
              AND generation.workspace_id=job.workspace_id
              AND generation.website_project_id=job.website_project_id
              AND generation.id=CASE
                WHEN job.result_summary->>'generationContractId' ~
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (
                  job.result_summary->>'generationContractId'
                )::uuid
                ELSE NULL
              END
            WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3
              AND job.job_type='recommendation_pool_v2_generation'
              AND job.source_object_type='project-context-snapshot'
              AND job.source_object_id=$4
              AND generation.pool_contract_version='recommendation-pool.v2'
              AND (
                job.result_summary->>'launchIdempotencyHash'=$5
                OR job.status IN ('queued','running','waiting_provider')
              )
            ORDER BY
              (job.result_summary->>'launchIdempotencyHash'=$5) DESC,
              generation.visible_pool_generation DESC
            LIMIT 1
            FOR UPDATE OF job`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.recommendationContextVersionId,
            launchIdempotencyHash,
          ],
        );
        const replay = replayResult.rows[0];
        if (replay !== undefined) {
          const launch = mapLaunch(replay, true);
          await createRecommendationPoolV2TimingRepository(client).record({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
            generationContractId: launch.generationContractId,
            jobId: launch.jobId,
            actorId: input.actorId,
            eventType: "COMMAND_ACCEPTED",
            idempotencyKey: `command-accepted:${launch.jobId}`,
            observedState: "QUEUED",
            details: { replayed: true },
          });
          return launch;
        }

        const inputPinFingerprint = hash({
          contract: "recommendation-pool-v2-input-pin.v1",
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          projectContextVersion: Number(current.projectContextVersion),
          siteProfileVersionId: current.siteProfileVersionId,
          outreachProfileVersionId: current.outreachProfileVersionId,
          promotionTargetVersionId: current.promotionTargetVersionId,
          keywordEvidenceSnapshotIds: current.keywordEvidenceSnapshotIds ?? [],
          sharedEvidenceSnapshotIds: current.sharedEvidenceSnapshotIds ?? [],
          market: current.inputPinMarket,
          qualificationContractVersion: "recommendation-pool-admission.v2",
        });
        await client.query(
          `INSERT INTO backlinks.backlink_generation_input_pins (
             id,organization_id,workspace_id,website_project_id,
             project_context_version,site_profile_version_id,
             outreach_profile_version_id,promotion_target_version_id,
             keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,
             market,qualification_contract_version,immutable_fingerprint,
             created_by
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,
             'recommendation-pool-admission.v2',$12,$13
           )
           ON CONFLICT (
             organization_id,workspace_id,website_project_id,
             immutable_fingerprint
           ) DO NOTHING`,
          [
            randomUUID(),
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.projectContextVersion,
            current.siteProfileVersionId,
            current.outreachProfileVersionId,
            current.promotionTargetVersionId,
            JSON.stringify(current.keywordEvidenceSnapshotIds ?? []),
            JSON.stringify(current.sharedEvidenceSnapshotIds ?? []),
            current.inputPinMarket,
            inputPinFingerprint,
            input.actorId,
          ],
        );
        const inputPinResult = await client.query(
          `SELECT id
             FROM backlinks.backlink_generation_input_pins
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND immutable_fingerprint=$4`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            inputPinFingerprint,
          ],
        );
        const inputPinId = inputPinResult.rows[0]?.id;
        if (typeof inputPinId !== "string") {
          throw new Error("RECOMMENDATION_POOL_V2_INPUT_PIN_NOT_PERSISTED");
        }

        const generationContractId = randomUUID();
        const jobId = randomUUID();
        const visiblePoolGeneration =
          Number(current.maximumVisiblePoolGeneration ?? 0) + 1;
        const workflowId = buildBacklinksWorkflowId({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          workflow: "recommendation-pool-v2",
          instanceId: generationContractId,
        });
        const launchFingerprint = hash({
          contract: "recommendation-pool-v2-generation.v1",
          generationContractId,
          recommendationContextVersionId:
            current.recommendationContextVersionId,
          visiblePoolGeneration,
          inputPinId,
        });

        await client.query(
          `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
             id,organization_id,workspace_id,website_project_id,
             recommendation_context_version_id,visible_pool_generation,
             input_pin_id,qualification_contract_version,
             visibility_contract_version,score_model_version,metric_scope,
             market,location,language,traffic_location_code,
             traffic_language_code,request_fingerprints,
             creator_worker_contract_version,created_by,
             pool_contract_version,seed_contract_version,
             release_contract_version,recommendation_marker_version,
             discovery_budget_policy_version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             COALESCE($17::jsonb,'{}'::jsonb) ||
               jsonb_build_object('nativeV2GenerationLaunch',$18::text),
             $19,$20,'recommendation-pool.v2',$21,$22,$23,$24
           )`,
          [
            generationContractId,
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.recommendationContextVersionId,
            visiblePoolGeneration,
            inputPinId,
            "recommendation-pool-admission.v2",
            "recommendation-pool-release-visibility.v2",
            "recommendation-pool-materialization.v2",
            current.metricScope,
            current.market,
            current.location,
            current.language,
            current.trafficLocationCode,
            current.trafficLanguageCode,
            JSON.stringify(current.requestFingerprints ?? {}),
            launchFingerprint,
            "recommendation-pool-worker.v2",
            input.actorId,
            "recommendation-seed.v2",
            current.releaseContractVersion,
            current.recommendationMarkerVersion,
            current.discoveryBudgetPolicyVersion,
          ],
        );
        await client.query(
          `INSERT INTO backlinks.backlink_jobs (
             id,organization_id,workspace_id,website_project_id,job_type,
             source_object_type,source_object_id,status,step,progress,
             workflow_id,correlation_id,result_summary,created_by,updated_by
           ) VALUES (
             $1,$2,$3,$4,'recommendation_pool_v2_generation',
             'project-context-snapshot',$5,'queued','generation_staged',0,
             $6,$7,$8::jsonb,$9,$9
           )`,
          [
            jobId,
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            current.recommendationContextVersionId,
            workflowId,
            input.requestId,
            JSON.stringify({
              poolContractVersion: "recommendation-pool.v2",
              generationContractId,
              visiblePoolGeneration,
              inputPinId,
              launchIdempotencyHash,
              launchFingerprint,
              providerBudgetAuthorization: input.providerBudgetAuthorization,
            }),
            input.actorId,
          ],
        );
        await createRecommendationPoolV2TimingRepository(client).record({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          generationContractId,
          jobId,
          actorId: input.actorId,
          eventType: "COMMAND_ACCEPTED",
          idempotencyKey: `command-accepted:${jobId}`,
          observedState: "QUEUED",
          details: { replayed: false },
        });
        return Object.freeze({
          generationContractId,
          recommendationContextVersionId: String(
            current.recommendationContextVersionId,
          ),
          visiblePoolGeneration,
          inputPinId,
          jobId,
          workflowId,
          replayed: false,
        });
      });
    },
    confirmLaunch(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const confirmationHash = hash({
          contract: "recommendation-pool-v2-confirmed-launch.v1",
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          generationContractId: input.generationContractId,
          seedSnapshotFingerprint: input.seedSnapshotFingerprint,
          idempotencyKey: input.idempotencyKey,
        });
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            [
              "recommendation-pool-v2-confirmed-launch.v1",
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.generationContractId,
            ].join(":"),
          ],
        );
        const launchResult = await client.query(
          `SELECT generation.id "generationContractId",
                  generation.recommendation_context_version_id
                    "recommendationContextVersionId",
                  generation.visible_pool_generation
                    "visiblePoolGeneration",
                  generation.input_pin_id "inputPinId",
                  job.id "jobId",job.workflow_id "workflowId",
                  job.status "jobStatus",job.step "jobStep",
                  job.error->>'retryable' "failureRetryable",
                  job.result_summary->>'workflowLaunchIdempotencyHash'
                    "workflowLaunchIdempotencyHash"
             FROM backlinks.backlink_recommendation_generation_contracts
               AS generation
             JOIN backlinks.backlink_jobs AS job
               ON job.organization_id=generation.organization_id
              AND job.workspace_id=generation.workspace_id
              AND job.website_project_id=generation.website_project_id
              AND job.job_type='recommendation_pool_v2_generation'
              AND job.source_object_type='project-context-snapshot'
              AND job.source_object_id=
                    generation.recommendation_context_version_id
              AND job.result_summary->>'generationContractId'=
                    generation.id::text
             JOIN backlinks.backlink_commercial_discovery_blueprints
               AS blueprint
               ON blueprint.organization_id=generation.organization_id
              AND blueprint.workspace_id=generation.workspace_id
              AND blueprint.website_project_id=
                    generation.website_project_id
              AND blueprint.project_context_version_id=
                    generation.recommendation_context_version_id
              AND blueprint.seed_snapshot_fingerprint=$5
              AND blueprint.status='active'
            WHERE generation.organization_id=$1
              AND generation.workspace_id=$2
              AND generation.website_project_id=$3
              AND generation.id=$4
              AND generation.pool_contract_version='recommendation-pool.v2'
            ORDER BY job.created_at DESC,job.id DESC
            LIMIT 1
            FOR UPDATE OF job`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.generationContractId,
            input.seedSnapshotFingerprint,
          ],
        );
        const row = launchResult.rows[0];
        if (row === undefined) {
          return conflict(
            "Confirmed recommendation seed snapshot is stale or invalid.",
          );
        }
        const seedResult = await client.query(
          `SELECT assignment.seed_fingerprint "seedFingerprint"
             FROM backlinks.backlink_commercial_blueprint_seeds AS assignment
             JOIN backlinks.backlink_commercial_discovery_blueprints
               AS blueprint
               ON blueprint.organization_id=assignment.organization_id
              AND blueprint.workspace_id=assignment.workspace_id
              AND blueprint.website_project_id=
                    assignment.website_project_id
              AND blueprint.id=assignment.blueprint_id
            WHERE assignment.organization_id=$1
              AND assignment.workspace_id=$2
              AND assignment.website_project_id=$3
              AND assignment.generation_contract_id=$4
              AND blueprint.seed_snapshot_fingerprint=$5
              AND blueprint.status='active'
            ORDER BY assignment.seed_ordinal`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.generationContractId,
            input.seedSnapshotFingerprint,
          ],
        );
        const seedFingerprints = seedResult.rows.map((seed) =>
          String(seed.seedFingerprint),
        );
        if (
          seedFingerprints.length === 0 ||
          seedFingerprints.some(
            (fingerprint) => !/^[a-f0-9]{64}$/u.test(fingerprint),
          )
        ) {
          return conflict(
            "Confirmed recommendation seed snapshot has no launchable seeds.",
          );
        }

        const priorHash =
          typeof row.workflowLaunchIdempotencyHash === "string"
            ? row.workflowLaunchIdempotencyHash
            : null;
        if (priorHash !== null && priorHash !== confirmationHash) {
          return conflict(
            "Recommendation generation was already launched with another request.",
          );
        }
        if (
          priorHash === null &&
          (row.jobStatus !== "queued" || row.jobStep !== "generation_staged")
        ) {
          return conflict(
            "Recommendation generation is no longer awaiting confirmation.",
          );
        }
        if (row.jobStatus === "failed") {
          if (priorHash === null || row.failureRetryable !== "true") {
            return conflict("Recommendation generation failure requires review before retry.");
          }
          // Resume the same job without resetting provider receipts, candidates,
          // or the original bounded authorization.
          await client.query(
            `UPDATE backlinks.backlink_jobs
                SET status='queued',step='generation_staged',progress=0,
                    finished_at=NULL,error=NULL,
                    result_summary=(
                      COALESCE(result_summary,'{}'::jsonb)
                      - 'final' - 'outcome' - 'terminalReason'
                      - 'failureCode' - 'failureMessage' - 'failureRetryable'
                    ) || jsonb_build_object(
                      'previousFailure',error,
                      'recoveryCount',COALESCE((result_summary->>'recoveryCount')::int,0)+1
                    ),
                    updated_at=statement_timestamp(),updated_by=$5,
                    version=version+1
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4
                AND status='failed' AND error->>'retryable'='true'`,
            [
              input.organizationId, input.workspaceId, input.websiteProjectId,
              row.jobId, input.actorId,
            ],
          );
        }
        if (priorHash === null) {
          await client.query(
            `UPDATE backlinks.backlink_jobs
                SET result_summary=
                      COALESCE(result_summary,'{}'::jsonb) ||
                      jsonb_build_object(
                        'confirmedSeedSnapshotFingerprint',$5::text,
                        'workflowLaunchIdempotencyHash',$6::text
                      ),
                    updated_at=statement_timestamp(),updated_by=$7,
                    version=version+1
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              row.jobId,
              input.seedSnapshotFingerprint,
              confirmationHash,
              input.actorId,
            ],
          );
        }
        return Object.freeze({
          ...mapLaunch(row, priorHash !== null),
          seedFingerprints: Object.freeze(seedFingerprints),
        });
      });
    },
  });
}
