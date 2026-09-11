import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSendIntentCommands } from "../../../src/modules/backlinks/application/commands/send-intent.command.js";
import { createMetricDashboardQuery } from "../../../src/modules/backlinks/application/queries/metric-dashboard.query.js";
import { createReportOverviewQuery } from "../../../src/modules/backlinks/application/queries/report-overview.query.js";
import {
  createDraftEditingRepository,
  createDraftGenerationRepository,
} from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import { createPlacementInitialValidationRepository } from "../../../src/modules/backlinks/application/repositories/placement-validation.repository.js";
import {
  buildMetricSnapshot,
  type MetricSnapshotStore,
} from "../../../src/modules/backlinks/application/services/metric-snapshot-builder.js";
import { PostgresqlReplyMatchRepository } from "../../../src/modules/backlinks/application/services/reply-match.repository.js";
import { PostgresqlSendIntentRepository } from "../../../src/modules/backlinks/application/services/send-intent.repository.js";
import {
  type ReportMetricSnapshot,
  type ReportRevisionStore,
  runReportRevisionWorkflow,
} from "../../../src/modules/backlinks/application/workflows/report-revision.workflow.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { backlinkMetricDefinitions } from "../../../src/modules/backlinks/domain/metrics/definitions.js";
import type { AiDraftResult } from "../../../src/modules/backlinks/ports/ai-draft.port.js";
import type { BacklinkTenantPool } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { createOpportunityRepository } from "../../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
  rowCount: number | null;
}>;
type Client = Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}>;
type Pool = BacklinkTenantPool & Readonly<{ end(): Promise<void> }>;
const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => Pool;
};
const id = (value: number) =>
  `019a9000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const outreachProfileId = id(10);
const inputPinId = id(11);
const contextSnapshotId = id(12);
const generationId = id(13);
const blueprintId = id(14);
const discoveryBatchId = id(15);
const releaseBatchId = id(16);
const feedItemId = id(17);
const prospectId = id(18);
const recommendationId = id(19);
const inventoryId = id(20);
const commercialCandidateId = id(21);
const generationCandidateId = id(27);
const contactCandidateId = id(22);
const contactEvidenceId = id(23);
const contactSnapshotId = id(24);
const publicationId = id(25);
const projectContractId = id(26);
const actorId = "phase9-canonical-chain-user";
const domain = "phase9-publisher.test";
const contactEmail = `editorial@${domain}`;

const scope = { organizationId, workspaceId, websiteProjectId } as const;
const metricAt = new Date("2026-08-28T12:00:00.000Z");

function nextId(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("Fixture ID sequence exhausted.");
    return value;
  };
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

async function seedReleasedV2Item(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO backlink_outreach_profile_versions (
      id, organization_id, workspace_id, website_project_id,
      profile_version_id, promotion_target_version_id,
      keywords_and_topics, products_and_services, target_urls,
      target_audiences, partnership_goals, market, location, language,
      authorized_discovery_sources, immutable_fingerprint, created_by
    ) VALUES (
      '${outreachProfileId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', 'profile-v2', 'promotion-target-v2',
      '["technical seo"]'::jsonb, '["seo platform"]'::jsonb,
      '["https://owner.test/resources"]'::jsonb, '["publishers"]'::jsonb,
      '["editorial coverage"]'::jsonb, 'US', 'United States', 'en',
      '["shared-seo-evidence"]'::jsonb, 'phase9-outreach-v2', 'fixture'
    );
    INSERT INTO backlink_generation_input_pins (
      id, organization_id, workspace_id, website_project_id,
      project_context_version, site_profile_version_id,
      outreach_profile_version_id, promotion_target_version_id,
      keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
      market, qualification_contract_version, immutable_fingerprint,
      created_by
    ) VALUES (
      '${inputPinId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', 9, 'site-profile-v2', '${outreachProfileId}',
      'promotion-target-v2', '[]'::jsonb, '[]'::jsonb, 'US',
      'recommendation-pool-admission.v2', 'phase9-input-v2', 'fixture'
    );
    INSERT INTO backlink_project_context_snapshots (
      id, organization_id, workspace_id, website_project_id,
      snapshot_version, project_status, canonical_domain, locale,
      country_code, profile_version_id, promotion_target_version_id,
      products, keywords, target_urls, created_by
    ) VALUES (
      '${contextSnapshotId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', 9, 'ACTIVE', 'owner.test', 'en-US', 'US',
      'site-profile-v2', 'promotion-target-v2',
      '["seo platform"]'::jsonb, '["technical seo"]'::jsonb,
      '["https://owner.test/resources"]'::jsonb, 'fixture'
    );
    INSERT INTO backlink_recommendation_generation_contracts (
      id, organization_id, workspace_id, website_project_id,
      recommendation_context_version_id, visible_pool_generation,
      input_pin_id, qualification_contract_version,
      visibility_contract_version, score_model_version, metric_scope,
      market, location, language, traffic_location_code,
      traffic_language_code, request_fingerprints,
      creator_worker_contract_version, created_by, pool_contract_version,
      seed_contract_version, release_contract_version,
      recommendation_marker_version, discovery_budget_policy_version
    ) VALUES (
      '${generationId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${contextSnapshotId}', 2, '${inputPinId}',
      'recommendation-pool-admission.v2',
      'recommendation-pool-release-visibility.v2',
      'recommendation-pool-materialization.v2', 'TARGET_MARKET', 'US',
      'United States', 'en', 2840, 'en', '{}'::jsonb,
      'recommendation-pool-worker.v2', 'fixture',
      'recommendation-pool.v2', 'recommendation-seed.v2',
      'recommendation-release.v2', 'recommendation-marker.v2',
      'recommendation-discovery-budget.v2'
    );
    UPDATE backlink_recommendation_generation_contracts
       SET effective_unique_candidate_count=1, canonical_batch_size=1,
           canonical_batch_count=1,
           canonical_order_fingerprint='phase9-canonical-order-v2',
           discovery_terminal_reason='BUDGET_COMPLETE',
           discovery_completed_at=statement_timestamp()
     WHERE id='${generationId}';
    INSERT INTO backlink_recommendation_pool_project_contracts (
      id, organization_id, workspace_id, website_project_id,
      pool_contract_version, migration_state, generation_contract_id,
      recommendation_context_version_id, visible_pool_generation,
      input_pin_id, state_reason_codes, activated_at, created_by, updated_by
    ) VALUES (
      '${projectContractId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', 'recommendation-pool.v2', 'V2_ACTIVE',
      '${generationId}', '${contextSnapshotId}', 2, '${inputPinId}',
      '[]'::jsonb, statement_timestamp(), 'fixture', 'fixture'
    );
    INSERT INTO backlink_commercial_discovery_blueprints (
      id, organization_id, workspace_id, website_project_id,
      project_context_version_id, blueprint_version, generator,
      schema_version, prompt_version, rule_version, blueprint,
      evidence_refs, generated_at, created_by
    ) VALUES (
      '${blueprintId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${contextSnapshotId}', 1,
      'DETERMINISTIC_FALLBACK', 'recommendation-blueprint.v2',
      'recommendation-seed.v2', 'recommendation-discovery.v2',
      '{}'::jsonb, '[]'::jsonb, statement_timestamp(), 'fixture'
    );
    INSERT INTO backlink_commercial_discovery_batches (
      id, organization_id, workspace_id, website_project_id, blueprint_id,
      project_context_version_id, status, idempotency_key, request_intent,
      source_types, provider_request_fingerprints, paid_cost_micros,
      started_at, finished_at, created_by, visible_pool_generation
    ) VALUES (
      '${discoveryBatchId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${blueprintId}', '${contextSnapshotId}',
      'completed', 'phase9-discovery-v2', 'DISCOVERY',
      '["EXISTING_HISTORY"]'::jsonb, '[]'::jsonb, 0,
      statement_timestamp(), statement_timestamp(), 'fixture', 2
    );
    INSERT INTO backlink_recommendation_release_batches (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, batch_ordinal, state,
      original_batch_size, selection_policy_version, order_fingerprint,
      contact_total_count, preparation_started_at, deadline_at,
      created_by, updated_by
    ) VALUES (
      '${releaseBatchId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${generationId}', '${contextSnapshotId}', 2,
      '${inputPinId}', 1, 'PREPARING', 1,
      'recommendation-release-selection.v2', 'phase9-release-order-v2', 1,
      statement_timestamp(), statement_timestamp()+interval '18 hours',
      'fixture', 'fixture'
    );
    INSERT INTO backlink_prospects (
      id, organization_id, workspace_id, website_project_id,
      recommendation_context_version_id, hostname_ascii,
      registrable_domain, normalization_version, created_by, updated_by
    ) VALUES (
      '${prospectId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${contextSnapshotId}', 'www.${domain}',
      '${domain}', 'tldts-v1', 'fixture', 'fixture'
    );
    INSERT INTO backlink_recommendations (
      id, organization_id, workspace_id, website_project_id, prospect_id,
      recommendation_context_version_id, status, created_by, updated_by
    ) VALUES (
      '${recommendationId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${prospectId}', '${contextSnapshotId}',
      'shown', 'fixture', 'fixture'
    );
    INSERT INTO backlink_recommendation_inventory (
      id, organization_id, workspace_id, website_project_id,
      recommendation_id, prospect_id, recommendation_context_version_id,
      visible_pool_generation, status, created_by, updated_by
    ) VALUES (
      '${inventoryId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${recommendationId}', '${prospectId}',
      '${contextSnapshotId}', 2, 'shown', 'fixture', 'fixture'
    );
    INSERT INTO backlink_commercial_candidates (
      id, organization_id, workspace_id, website_project_id, blueprint_id,
      discovery_batch_id, recommendation_id, prospect_id,
      project_context_version_id, canonical_domain, source_types,
      static_assessment, gate_decision, commercial_score,
      score_model_version, state, provider_collected_at,
      created_by, updated_by, visible_pool_generation
    ) VALUES (
      '${commercialCandidateId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${blueprintId}', '${discoveryBatchId}',
      '${recommendationId}', '${prospectId}', '${contextSnapshotId}',
      '${domain}', '["EXISTING_HISTORY"]'::jsonb, '{}'::jsonb,
      '{"decision":"eligible","hitGates":[],"missingEvidence":[]}'::jsonb,
      '{"decision":"eligible","total":72,"scoreModelVersion":"recommendation-commercial-fit.v4","ruleVersion":"recommendation-commercial-fit-rules.v4.2","admission":{"appliedThreshold":50}}'::jsonb,
      'recommendation-commercial-fit.v4', 'candidate_ready',
      statement_timestamp(), 'fixture', 'fixture', 2
    );
    INSERT INTO backlink_recommendation_generation_candidates (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      canonical_domain, admission_state, admission_contract_version,
      exclusion_evidence, decision_evidence, first_seen_request_intent,
      recommended, recommendation_reason_codes, first_seen_at, admitted_at,
      decided_at, created_by
    ) VALUES (
      '${generationCandidateId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${generationId}', '${contextSnapshotId}', 2,
      '${inputPinId}', 'recommendation-pool.v2', '${domain}', 'ADMITTED',
      'recommendation-pool-admission.v2', '{}'::jsonb,
      '{"contractVersion":"recommendation-pool-admission.v2","passedRequiredExclusions":true}'::jsonb,
      'EXISTING_HISTORY', true, '["COMMERCIAL_FIT"]'::jsonb,
      statement_timestamp(), statement_timestamp(), statement_timestamp(),
      'fixture'
    );
    INSERT INTO backlink_contact_candidates (
      id, organization_id, workspace_id, website_project_id, prospect_id,
      recommendation_context_version_id, normalized_email,
      email_domain_ascii, domain_relation, syntax_validator_version,
      confidence, guessed, status, inferred_purpose, purpose_confidence,
      created_by, updated_by
    ) VALUES (
      '${contactCandidateId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${prospectId}', '${contextSnapshotId}',
      '${contactEmail}', '${domain}', 'same_registrable_domain',
      'email-syntax.v1', 95, false, 'candidate', 'editorial', 95,
      'fixture', 'fixture'
    );
    INSERT INTO backlink_contact_evidence (
      id, organization_id, workspace_id, website_project_id, candidate_id,
      source_url, observed_at, extraction_method, evidence_snippet,
      parser_version, content_sha256, confidence, expires_at, created_by
    ) VALUES (
      '${contactEvidenceId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${contactCandidateId}',
      'https://www.${domain}/contact', statement_timestamp(), 'visible_text',
      '${contactEmail}', 'contact-parser.v1', repeat('b',64), 95,
      statement_timestamp()+interval '30 days', 'fixture'
    );
    INSERT INTO backlink_contact_evidence_snapshots (
      id, organization_id, workspace_id, website_project_id,
      recommendation_id, prospect_id, recommendation_context_version_id,
      contact_candidate_id, contact_evidence_id, source_url, email_sha256,
      email_reference, inferred_purpose, contact_confidence,
      purpose_confidence, evidence_confidence, collected_at, rules_version,
      created_by
    ) VALUES (
      '${contactSnapshotId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${recommendationId}', '${prospectId}',
      '${contextSnapshotId}', '${contactCandidateId}', '${contactEvidenceId}',
      'https://www.${domain}/contact', repeat('c',64),
      'contact-evidence:${contactEvidenceId}', 'editorial', 95, 95, 95,
      statement_timestamp(), 'contact-publication.v1', 'fixture'
    );
    UPDATE backlink_recommendation_inventory
       SET publication_status='PUBLISHED', fit_decision='eligible',
           fit_score_model_version='recommendation-commercial-fit.v4',
           contact_decision='eligible',
           contact_reason_code='PUBLIC_EMAIL_FOUND',
           verified_public_email_count=1,
           contact_evidence_snapshot_id='${contactSnapshotId}',
           default_contact_candidate_id='${contactCandidateId}',
           default_contact_source_url='https://www.${domain}/contact',
           default_contact_email_sha256=repeat('c',64),
           default_contact_email_reference='contact-evidence:${contactEvidenceId}',
           contact_collected_at=statement_timestamp(),
           contact_rules_version='contact-publication.v1',
           updated_at=statement_timestamp()
     WHERE id='${inventoryId}';
    INSERT INTO backlink_recommendation_release_batch_items (
      id, organization_id, workspace_id, website_project_id, batch_id,
      recommendation_context_version_id, visible_pool_generation,
      candidate_id, generation_candidate_id, recommendation_id, prospect_id,
      inventory_id,
      generation_contract_id, input_pin_id, canonical_domain, position,
      recommended, recommendation_reason_codes,
      recommendation_marker_version, traffic_snapshot, rank_snapshot,
      spam_snapshot, contact_terminal_reason_at_release,
      contact_email_at_release, contact_page_url_at_release,
      contact_completed_at_release, created_by
    ) VALUES (
      '${feedItemId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${releaseBatchId}', '${contextSnapshotId}', 2,
      '${commercialCandidateId}', '${generationCandidateId}',
      '${recommendationId}', '${prospectId}', '${inventoryId}',
      '${generationId}', '${inputPinId}', '${domain}', 1,
      true, '["COMMERCIAL_FIT"]'::jsonb, 'recommendation-marker.v2',
      '{"value":null,"provider":"fixture","endpoint":"fixture/traffic","market":"US","location":"United States","language":"en","observedAt":"2026-08-28T00:00:00.000Z","artifactRef":"phase9:traffic"}'::jsonb,
      '{"value":null,"provider":"fixture","endpoint":"fixture/rank","market":"US","location":"United States","language":"en","observedAt":"2026-08-28T00:00:00.000Z","artifactRef":"phase9:rank"}'::jsonb,
      '{"value":null,"provider":"fixture","endpoint":"fixture/spam","market":"US","location":"United States","language":"en","observedAt":"2026-08-28T00:00:00.000Z","artifactRef":"phase9:spam"}'::jsonb,
      'PUBLIC_EMAIL_FOUND', '${contactEmail}',
      'https://www.${domain}/contact', statement_timestamp(), 'fixture'
    );
    UPDATE backlink_recommendation_release_batches
       SET state='AVAILABLE', contact_terminal_count=1,
           available_at=statement_timestamp(), updated_at=statement_timestamp(),
           updated_by='fixture', version=2
     WHERE id='${releaseBatchId}';
    INSERT INTO backlink_recommendation_user_publications (
      id, organization_id, workspace_id, website_project_id,
      recommendation_context_version_id, visible_pool_generation, user_id,
      batch_id, published_by_command_id, created_by, updated_by
    ) VALUES (
      '${publicationId}', '${organizationId}', '${workspaceId}',
      '${websiteProjectId}', '${contextSnapshotId}', 2, '${actorId}',
      '${releaseBatchId}', 'phase9-publish', 'fixture', 'fixture'
    );
  `);
}

async function activatePhase9Freeze(client: Client): Promise<void> {
  const phase8Verification = (
    await client.query(
      `SELECT backlink_recommendation_pool_v2_verify_cutover()
         AS verification`,
    )
  ).rows[0]?.verification;
  expect(phase8Verification).toMatchObject({
    completed: true,
    eligibleProjectCount: 1,
    v2ActiveProjectCount: 1,
    validV2ActiveProjectCount: 1,
    activeV1GenerationCount: 0,
  });

  await client.query(
    `SELECT *
       FROM backlink_recommendation_pool_v2_start_cutover_run(
         $1,$2,'VERIFY',$3
       )`,
    [id(9001), "phase9-chain-phase8-verify", "fixture"],
  );
  await client.query(
    `SELECT backlink_recommendation_pool_v2_finish_cutover_run(
       $1,'COMPLETED',1,1,0,0,$2::jsonb,$3,clock_timestamp()
     )`,
    [id(9001), JSON.stringify(phase8Verification), "fixture"],
  );

  const plan = (
    await client.query(
      `SELECT backlink_recommendation_pool_v2_phase9_run(
         $1,$2,'PLAN',$3,clock_timestamp()
       ) AS run`,
      [id(9002), "phase9-chain-plan", "fixture"],
    )
  ).rows[0]?.run;
  expect(plan).toMatchObject({
    status: "PLANNED",
    verification: {
      completed: false,
      readyForExecute: true,
      v1WritesFrozen: false,
    },
  });

  const execute = (
    await client.query(
      `SELECT backlink_recommendation_pool_v2_phase9_run(
         $1,$2,'EXECUTE',$3,clock_timestamp()
       ) AS run`,
      [id(9003), "phase9-chain-execute", "fixture"],
    )
  ).rows[0]?.run;
  expect(execute).toMatchObject({
    status: "COMPLETED",
    verification: {
      completed: true,
      readyForExecute: true,
      v1WritesFrozen: true,
      phase9FreezeTriggersInstalled: true,
    },
  });

  const verify = (
    await client.query(
      `SELECT backlink_recommendation_pool_v2_phase9_run(
         $1,$2,'VERIFY',$3,clock_timestamp()
       ) AS run`,
      [id(9004), "phase9-chain-verify", "fixture"],
    )
  ).rows[0]?.run;
  expect(verify).toMatchObject({
    status: "COMPLETED",
    verification: {
      completed: true,
      v1WritesFrozen: true,
    },
  });
}

function metricStore(client: Client): MetricSnapshotStore {
  return {
    async findLatest() {
      return null;
    },
    async append(snapshot) {
      await client.query(
        `INSERT INTO backlink_metric_snapshots (
           id, organization_id, workspace_id, website_project_id,
           metric_key, metric_definition_version, snapshot_version,
           window_start, window_end, as_of, workspace_timezone, dimensions,
           dimension_hash, numerator, denominator, value_numeric,
           source_started_at, source_ended_at, source_fact_count,
           source_fact_ids, source_watermark_at, source_watermark_id,
           input_checksum, result_checksum, computed_at, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,
           $17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26
         )`,
        [
          snapshot.id,
          snapshot.organizationId,
          snapshot.workspaceId,
          snapshot.websiteProjectId,
          snapshot.metricKey,
          snapshot.metricDefinitionVersion,
          snapshot.snapshotVersion,
          snapshot.windowStart,
          snapshot.windowEnd,
          snapshot.asOf,
          snapshot.workspaceTimezone,
          JSON.stringify(snapshot.dimensions),
          snapshot.dimensionHash,
          snapshot.numerator,
          snapshot.denominator,
          snapshot.value,
          snapshot.sourceStartedAt,
          snapshot.sourceEndedAt,
          snapshot.sourceFactCount,
          JSON.stringify(snapshot.sourceFactIds),
          snapshot.sourceWatermarkAt,
          snapshot.sourceWatermarkId,
          snapshot.inputChecksum,
          snapshot.resultChecksum,
          snapshot.computedAt,
          snapshot.createdBy,
        ],
      );
    },
  };
}

function reportStore(
  client: Client,
  reportPublicationId: string,
): ReportRevisionStore {
  return {
    async loadSnapshots(projectScope, snapshotIds) {
      const result = await client.query(
        `SELECT id, organization_id AS "organizationId",
                workspace_id AS "workspaceId",
                website_project_id AS "websiteProjectId",
                metric_key AS "metricKey",
                metric_definition_version AS "metricDefinitionVersion",
                source_started_at AS "sourceStartedAt",
                source_ended_at AS "sourceEndedAt",
                source_watermark_at AS "sourceWatermarkAt",
                source_watermark_id AS "sourceWatermarkId",
                result_checksum AS "resultChecksum", value_numeric AS value
           FROM backlink_metric_snapshots
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=ANY($4::uuid[])`,
        [
          projectScope.organizationId,
          projectScope.workspaceId,
          projectScope.websiteProjectId,
          snapshotIds,
        ],
      );
      return result.rows.map((row): ReportMetricSnapshot => ({
        id: String(row.id),
        organizationId: String(row.organizationId),
        workspaceId: String(row.workspaceId),
        websiteProjectId: String(row.websiteProjectId),
        metricKey: String(row.metricKey),
        metricDefinitionVersion: String(row.metricDefinitionVersion),
        sourceStartedAt: asDate(row.sourceStartedAt),
        sourceEndedAt: asDate(row.sourceEndedAt),
        sourceWatermarkAt: asDate(row.sourceWatermarkAt),
        sourceWatermarkId: String(row.sourceWatermarkId),
        resultChecksum: String(row.resultChecksum),
        value: row.value === null ? null : Number(row.value),
      }));
    },
    async getPublished() {
      return null;
    },
    async publish(revision, expectedPublishedRevision) {
      if (expectedPublishedRevision !== null) {
        throw new Error("Phase 9 fixture expected a first report revision.");
      }
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO backlink_report_revisions (
             id, organization_id, workspace_id, website_project_id,
             report_key, revision, input_snapshot_ids,
             metric_definition_versions, query_spec, report_payload,
             source_started_at, source_ended_at, source_watermark_at,
             source_watermark_id, input_checksum, result_checksum,
             generated_at, created_by
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
             $11,$12,$13,$14,$15,$16,$17,$18
           )`,
          [
            revision.id,
            revision.organizationId,
            revision.workspaceId,
            revision.websiteProjectId,
            revision.reportKey,
            revision.revision,
            JSON.stringify(revision.inputSnapshotIds),
            JSON.stringify(revision.metricDefinitionVersions),
            JSON.stringify(revision.querySpec),
            JSON.stringify(revision.payload),
            revision.sourceStartedAt,
            revision.sourceEndedAt,
            revision.sourceWatermarkAt,
            revision.sourceWatermarkId,
            revision.inputChecksum,
            revision.resultChecksum,
            revision.generatedAt,
            revision.createdBy,
          ],
        );
        await client.query(
          `INSERT INTO backlink_report_publications (
             id, organization_id, workspace_id, website_project_id,
             report_key, report_revision_id, report_revision, published_at,
             published_by, updated_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [
            reportPublicationId,
            revision.organizationId,
            revision.workspaceId,
            revision.websiteProjectId,
            revision.reportKey,
            revision.id,
            revision.revision,
            revision.generatedAt,
            revision.createdBy,
          ],
        );
        await client.query("COMMIT");
        return revision;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("Phase 9 V2 released item canonical PostgreSQL chain", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let tenantPool: Pool;
  let tenantRole: string;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await installBacklinksManifestAfterFoundation(admin, "0092");
    await admin.query("SET search_path = backlinks, pg_catalog");

    tenantRole = `phase9_chain_${randomBytes(8).toString("hex")}`;
    const tenantPassword = randomBytes(24).toString("base64url");
    await admin.query(
      `CREATE ROLE "${tenantRole}" LOGIN PASSWORD '${tenantPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
       GRANT growthos_backlinks_writer TO "${tenantRole}"`,
    );
    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = tenantRole;
    tenantUrl.password = tenantPassword;
    tenantPool = new PgPool({ connectionString: tenantUrl.toString(), max: 4 });
  }, 180_000);

  afterAll(async () => {
    await tenantPool?.end();
    if (admin !== undefined && tenantRole !== undefined) {
      await admin.query(`DROP OWNED BY "${tenantRole}"`);
      await admin.query(`DROP ROLE "${tenantRole}"`);
    }
    await admin?.end();
    await harness?.stop();
  });

  it("flows through canonical facts without invoking real providers", async () => {
    await seedReleasedV2Item(admin);
    await activatePhase9Freeze(admin);

    const opportunityId = id(1001);
    const opportunityCycleId = id(1002);
    const contactId = id(1003);
    const opportunityResult = await createOpportunityRepository(
      admin,
    ).createFromRecommendationFeedItem({
      ...scope,
      actorId,
      recommendationFeedItemId: feedItemId,
      idempotencyKey: "phase9-feed-to-opportunity",
      requestHash: "phase9-feed-to-opportunity-request",
      requestId: "phase9-feed-to-opportunity-request-id",
      idempotencyRecordId: id(1000),
      opportunityId,
      cycleId: opportunityCycleId,
      lifecycleEventId: id(1004),
      auditEventId: id(1005),
      contactId,
      opportunityCreatedActionId: id(1006),
    });
    expect(opportunityResult).toMatchObject({
      state: "completed",
      responseBody: {
        opportunityId,
        recommendationFeedItemId: feedItemId,
        targetSiteKey: domain,
        contactCandidateId,
        contactReviewRequired: false,
      },
    });

    const draftRepository = createDraftGenerationRepository(admin);
    const evidenceSnapshotId = id(2001);
    const requestSnapshotId = id(2002);
    const draftId = id(2003);
    const runId = id(2004);
    const draftVersionId = id(2005);
    const draftRecordedAt = new Date("2026-08-28T01:00:00.000Z");
    await draftRepository.prepareEvidenceSnapshot({
      ...scope,
      opportunityId,
      contactId,
      contactVersion: 1,
      snapshotId: evidenceSnapshotId,
      requestSnapshotId,
      request: {
        cooperationType: "GENERAL_PARTNERSHIP",
        linkAttributePreference: "NOT_SPECIFIED",
        promotionTargetUrl: "https://owner.test/resources",
        anchorTextSuggestion: null,
        language: "en-US",
        tone: "NEUTRAL_BUSINESS",
        subjectStyle: "CLEAR_DIRECT",
        additionalRequirements: "",
        forbiddenPhrases: [],
      },
      actorId,
      recordedAt: draftRecordedAt,
    });
    const evidence = (
      await admin.query(
        `SELECT evidence_items AS "evidenceItems",
                context_data AS "contextData"
           FROM backlink_evidence_snapshots WHERE id=$1`,
        [evidenceSnapshotId],
      )
    ).rows[0];
    expect(evidence?.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "recommendation-selection:v2",
          dataVersion:
            "recommendation-marker.v2:recommendation-release-selection.v2",
        }),
      ]),
    );
    expect(evidence?.contextData).toMatchObject({
      opportunity: {
        targetContext: {
          recommendationPoolV2: {
            contractVersion: "recommendation-pool.v2",
            recommendationFeedItemId: feedItemId,
          },
        },
      },
    });
    await draftRepository.createJob({
      ...scope,
      opportunityId,
      contactId,
      contactVersion: 1,
      evidenceSnapshotId,
      requestSnapshotId,
      draftId,
      runId,
      logicalDraftKey: "phase9-canonical-draft",
      idempotencyKey: "phase9-canonical-draft-run",
      requestHash: "d".repeat(64),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
      generationMode: "MODEL",
      actorId,
      recordedAt: draftRecordedAt,
    });
    const mutation = {
      ...scope,
      runId,
      actorId,
      recordedAt: new Date("2026-08-28T01:01:00.000Z"),
    } as const;
    await draftRepository.claimJob(mutation);
    const promptContext = await draftRepository.loadPromptContext(mutation);
    expect(
      promptContext.approvedEvidence.map(({ id: evidenceId }) => evidenceId),
    ).toContain("recommendation-selection:v2");
    const fakeAiResult: AiDraftResult = {
      output: {
        subject: "Evidence-led collaboration",
        bodyText:
          "We found a relevant editorial fit and would like to discuss a collaboration.",
        factsUsed: [
          {
            claim: "The publisher was released by the V2 recommendation pool.",
            evidenceIds: ["recommendation-selection:v2"],
          },
        ],
        riskFlags: [],
        requiresUserConfirmation: true,
        canAutoSend: false,
      },
      usage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0,
      model: {
        providerRef: "fixture-ai",
        modelId: "fixture",
        modelVersion: "fixture-v1",
      },
      latencyMs: 1,
      repairCount: 0,
    };
    const completedDraft = await draftRepository.completeJob({
      ...mutation,
      versionId: draftVersionId,
      result: fakeAiResult,
      source: "MODEL",
      fallbackReason: null,
    });
    const draftEditingRepository = createDraftEditingRepository(admin, {
      newId: nextId([id(2006), id(2007)]),
    });
    expect(
      await draftEditingRepository.approve({
        ...scope,
        draftId,
        expectedVersion: completedDraft.draftVersion,
        actorId,
        recordedAt: new Date("2026-08-28T01:02:00.000Z"),
      }),
    ).toMatchObject({
      state: "completed",
      status: "approved",
      versionId: draftVersionId,
    });

    const secretReferenceId = id(3001);
    const gmailConnectionId = id(3002);
    await admin.query(`
      INSERT INTO backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${secretReferenceId}', '${organizationId}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/phase9-gmail', '1',
        'fixture', 'fixture'
      );
      INSERT INTO backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${gmailConnectionId}', '${organizationId}', '${actorId}',
        'phase9-google-subject', 'sender@owner.test',
        '["openid","email","profile","https://www.googleapis.com/auth/gmail.send"]'::jsonb,
        '${secretReferenceId}', statement_timestamp()+interval '1 hour',
        'fixture', 'fixture'
      );
      INSERT INTO backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, gmail_connection_id,
        created_by, updated_by
      ) VALUES (
        '${id(3003)}', '${organizationId}', '${workspaceId}',
        '${gmailConnectionId}', 'fixture', 'fixture'
      );
      INSERT INTO backlink_website_project_mailbox_bindings (
        id, organization_id, workspace_id, website_project_id,
        gmail_workspace_binding_id, created_by, updated_by
      ) VALUES (
        '${id(3004)}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', '${id(3003)}', 'fixture', 'fixture'
      );
      INSERT INTO backlink_gmail_send_identities (
        id, organization_id, gmail_connection_id, normalized_email,
        is_primary, is_default, verification_status, treat_as_alias,
        source, observed_at, created_by, updated_by
      ) VALUES (
        '${id(3005)}', '${organizationId}', '${gmailConnectionId}',
        'sender@owner.test', true, true, 'accepted', false, 'OIDC_PRIMARY',
        statement_timestamp(), 'fixture', 'fixture'
      );
      INSERT INTO backlink_kill_switch_versions (
        id, organization_id, workspace_id, website_project_id, layer,
        capability, provider, version, blocked, reason, created_by
      ) VALUES (
        '${id(3006)}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', 'project', 'GMAIL_SEND', NULL, 1, false,
        'phase9 fixture send enabled', 'fixture'
      );
    `);
    const context = {
      actor: createActorContext({
        userId: actorId,
        sessionId: "phase9-canonical-chain",
        roles: ["owner"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "site-profile-v2",
        promotionTargetVersionId: "promotion-target-v2",
      }),
    };
    let workerChecks = 0;
    let credentialChecks = 0;
    const sendTime = new Date("2026-08-28T02:00:00.000Z");
    const sendIntentId = id(3010);
    const sendCommands = createSendIntentCommands({
      repository: new PostgresqlSendIntentRepository({ pool: tenantPool }),
      sendRuntimeEnabled: true,
      workerAvailable: async () => {
        workerChecks += 1;
        return true;
      },
      gmailCredentialAvailable: async () => {
        credentialChecks += 1;
        return true;
      },
      newId: nextId([sendIntentId, id(3011), id(3012), id(3013)]),
      now: () => sendTime,
      quotaProfile: {
        rolling24HourSendLimit: 5,
        minimumIntervalSeconds: 1,
      },
    });
    const sendInput = {
      context,
      draftId,
      approvedDraftVersionId: draftVersionId,
      contactId,
      contactVersion: 1,
      gmailConnectionId,
      messagePurpose: "INITIAL_OUTREACH" as const,
      followUpIndex: 0,
    };
    const preflight = await sendCommands.preflight(sendInput);
    expect(
      await sendCommands.create({
        ...sendInput,
        idempotencyKey: "phase9-send-intent",
        readinessSnapshot: preflight.readinessSnapshot,
        humanConfirmation: {
          confirmed: true,
          confirmedAt: preflight.checkedAt,
          readinessSnapshotVersion: preflight.readinessSnapshot.snapshotVersion,
        },
      }),
    ).toMatchObject({ sendIntentId, status: "READY" });
    expect({ workerChecks, credentialChecks }).toEqual({
      workerChecks: 1,
      credentialChecks: 1,
    });

    const inboundMessageId = id(3023);
    await admin.query(`
      INSERT INTO backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        history_id, raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${id(3020)}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', '${gmailConnectionId}',
        'fixture-reply-message', 'fixture-phase9-thread', '9001',
        'mail/raw/phase9-reply', repeat('e',64), 42,
        statement_timestamp(), statement_timestamp()+interval '30 days',
        'fixture'
      );
      INSERT INTO backlink_mail_threads (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_thread_id, message_count,
        created_by, updated_by
      ) VALUES (
        '${id(3021)}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', '${gmailConnectionId}',
        'fixture-phase9-thread', 1, 'fixture', 'fixture'
      );
      INSERT INTO backlink_mail_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, raw_message_reference_id, mail_thread_id,
        rfc_message_id, reference_message_ids, from_address, to_addresses,
        subject_text, received_at, direction, parse_status, parsed_at,
        created_by, updated_by
      ) VALUES (
        '${id(3022)}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', '${gmailConnectionId}', '${id(3020)}',
        '${id(3021)}', '<phase9-reply@publisher.test>',
        '["<phase9-outbound@owner.test>"]'::jsonb, '${contactEmail}',
        '["sender@owner.test"]'::jsonb, 'Re: Evidence-led collaboration',
        statement_timestamp(), 'INBOUND', 'PARSED', statement_timestamp(),
        'fixture', 'fixture'
      );
      INSERT INTO backlink_inbound_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, mail_message_id, received_at,
        created_by, updated_by
      ) VALUES (
        '${inboundMessageId}', '${organizationId}', '${workspaceId}',
        '${websiteProjectId}', '${gmailConnectionId}', '${id(3022)}',
        statement_timestamp(), 'fixture', 'fixture'
      );
    `);
    const replyRepository = new PostgresqlReplyMatchRepository({
      pool: tenantPool,
      newId: nextId([id(3030), id(3031), id(3032)]),
      now: () => new Date("2026-08-28T03:00:00.000Z"),
    });
    expect(
      await replyRepository.saveMatchResult({
        ...scope,
        gmailConnectionId,
        inboundMessageId,
        actorId: "fixture-reply-matcher",
        result: {
          decision: "AUTO_MATCHED",
          confidence: "HIGH",
          matchedOpportunityId: opportunityId,
          matchedMailThreadId: id(3021),
          ruleVersion: "reply-matcher-v1",
          candidates: [
            {
              opportunityId,
              mailThreadId: id(3021),
              confidence: "HIGH",
              requiresManualConfirmation: false,
              evidence: [
                {
                  kind: "PROVIDER_THREAD_EXACT",
                  providerThreadId: "fixture-phase9-thread",
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({
      state: "saved",
      matchStatus: "MATCH_CONFIRMED",
      candidates: [
        expect.objectContaining({
          opportunityId,
          requiresManualConfirmation: false,
        }),
      ],
    });
    const replyFact = (
      await admin.query(
        `SELECT event_type AS "eventType", after_state AS "afterState"
           FROM backlink_lifecycle_events
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND aggregate_type='reply_assignment'
            AND aggregate_id=$4`,
        [organizationId, workspaceId, websiteProjectId, inboundMessageId],
      )
    ).rows[0];
    expect(replyFact).toMatchObject({
      eventType: "reply.assignment.recorded",
      afterState: {
        opportunityId,
        contractVersion: "reply-assignment-fact.v1",
      },
    });

    const placementCandidateId = id(4001);
    const placementId = id(4003);
    await admin.query(
      `INSERT INTO backlink_placement_candidates (
         id, organization_id, workspace_id, website_project_id,
         opportunity_id, reply_id, planned_placement_id, source_type,
         source_external_id, source_page_url, normalized_source_url,
         normalized_source_url_hash, target_url, normalized_target_url,
         normalized_target_url_hash, url_normalization_version, status,
         match_status, initial_validation_status,
         discovery_evidence_snapshot, discovery_evidence_hash,
         evidence_contract_version, evidence_schema_version,
         created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'manual','phase9-reply',
         'https://www.phase9-publisher.test/resources/owner',
         'https://www.phase9-publisher.test/resources/owner',$8,
         'https://owner.test/resources','https://owner.test/resources',$9,
         'url-normalization.v1','PENDING_VALIDATION','AUTO_MATCHED','PENDING',
         $10::jsonb,$11,'placement-discovery-evidence.v1',1,
         'fixture','fixture'
       )`,
      [
        placementCandidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        opportunityId,
        inboundMessageId,
        placementId,
        "a".repeat(64),
        "b".repeat(64),
        JSON.stringify({ source: "fixture-reply", replyId: inboundMessageId }),
        "c".repeat(64),
      ],
    );
    const placementRepository =
      createPlacementInitialValidationRepository(admin);
    expect(
      await placementRepository.record({
        ...scope,
        candidateId: placementCandidateId,
        expectedCandidateVersion: 1,
        validationRunId: id(4002),
        placementId,
        monitoringOutboxEventId: id(4004),
        placementLifecycleEventId: id(4005),
        status: "VALID",
        evidenceSnapshot: {
          source: "fixture-page-check",
          sourcePageUrl: "https://www.phase9-publisher.test/resources/owner",
        },
        evidenceSnapshotHash: "d".repeat(64),
        evidenceContractVersion: "placement-validation-evidence.v1",
        evidenceSchemaVersion: 1,
        evidenceObservedAt: new Date("2026-08-28T04:00:00.000Z"),
        verifiedAt: new Date("2026-08-28T04:00:00.000Z"),
        verifiedBy: "fixture-placement-validator",
        auditEventId: "phase9-placement-audit",
        initialEvidenceRef: "fixture://phase9-placement",
      }),
    ).toMatchObject({
      state: "recorded",
      status: "VALID",
      placementId,
    });
    const placementFact = (
      await admin.query(
        `SELECT id, event_type AS "eventType", created_at AS "createdAt",
                after_state AS "afterState"
           FROM backlink_lifecycle_events
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND aggregate_type='placement'
            AND aggregate_id=$4 AND event_type='placement.confirmed'`,
        [organizationId, workspaceId, websiteProjectId, placementId],
      )
    ).rows[0];
    expect(placementFact).toMatchObject({
      id: id(4005),
      eventType: "placement.confirmed",
    });

    const gainedPlacementDefinition = backlinkMetricDefinitions.find(
      ({ metricKey }) => metricKey === "gained_placement_count",
    );
    if (gainedPlacementDefinition === undefined) {
      throw new Error("gained_placement_count definition is missing.");
    }
    const metricSnapshotId = id(5001);
    const metricResult = await buildMetricSnapshot(
      {
        scope,
        definition: gainedPlacementDefinition,
        window: {
          start: new Date("2026-08-28T00:00:00.000Z"),
          end: metricAt,
          asOf: metricAt,
        },
        workspaceTimezone: "UTC",
        dimensions: {},
        facts: [
          {
            factId: String(placementFact?.id),
            sourceName: "backlink_lifecycle_events",
            eventType: "placement.confirmed",
            contractVersion: "event-schema.v1",
            occurredAt: asDate(placementFact?.createdAt),
            payload: placementFact?.afterState as Readonly<
              Record<string, unknown>
            >,
          },
        ],
        createdBy: "fixture-metric-builder",
      },
      {
        store: metricStore(admin),
        evaluate: ({ facts }) => ({
          numerator: facts.length,
          denominator: null,
          value: facts.length,
        }),
        newId: () => metricSnapshotId,
        now: () => metricAt,
      },
    );
    expect(metricResult).toMatchObject({
      status: "created",
      snapshot: {
        id: metricSnapshotId,
        value: 1,
        sourceFactIds: [id(4005)],
      },
    });

    const reportRevisionId = id(5002);
    const report = await runReportRevisionWorkflow(
      {
        scope,
        reportKey: "phase9-canonical-chain",
        inputSnapshotIds: [metricSnapshotId],
        querySpec: { metricKey: "gained_placement_count" },
        createdBy: "fixture-report-builder",
      },
      {
        store: reportStore(admin, id(5003)),
        generator: {
          async generate({ snapshots }) {
            return {
              metricKey: snapshots[0]?.metricKey,
              confirmedPlacementCount: snapshots[0]?.value,
              source: "fixture-phase9",
            };
          },
        },
        newId: () => reportRevisionId,
        now: () => metricAt,
      },
    );
    expect(report).toMatchObject({
      id: reportRevisionId,
      revision: 1,
      payload: {
        metricKey: "gained_placement_count",
        confirmedPlacementCount: 1,
        source: "fixture-phase9",
      },
    });

    const dashboard = await createMetricDashboardQuery(admin).getDashboard({
      scope,
      from: new Date("2026-08-28T00:00:00.000Z"),
      to: metricAt,
      asOf: metricAt,
      timezone: "UTC",
    });
    expect(dashboard.summary).toContainEqual(
      expect.objectContaining({
        snapshotId: metricSnapshotId,
        metricKey: "gained_placement_count",
        value: 1,
      }),
    );
    const reports = await createReportOverviewQuery(admin).listPublished({
      scope,
      asOf: metricAt,
      reportKey: "phase9-canonical-chain",
    });
    expect(reports).toEqual([
      expect.objectContaining({
        id: reportRevisionId,
        inputSnapshotIds: [metricSnapshotId],
        payload: expect.objectContaining({
          confirmedPlacementCount: 1,
        }),
      }),
    ]);

    const facts = await admin.query(
      `SELECT
         (SELECT count(*) FROM backlink_opportunities WHERE id=$1) AS opportunity,
         (SELECT count(*) FROM backlink_email_drafts
           WHERE id=$8 AND approved_version_id=$2 AND status='approved')
           AS draft,
         (SELECT count(*) FROM backlink_send_intents
           WHERE id=$3 AND status='READY') AS send_intent,
         (SELECT count(*) FROM backlink_lifecycle_events
           WHERE aggregate_id=$4 AND event_type='reply.assignment.recorded')
           AS reply_assignment,
         (SELECT count(*) FROM backlink_placements
           WHERE id=$5 AND reply_id=$4) AS placement,
         (SELECT count(*) FROM backlink_metric_snapshots
           WHERE id=$6 AND source_fact_ids @> $7::jsonb) AS metric_fact`,
      [
        opportunityId,
        draftVersionId,
        sendIntentId,
        inboundMessageId,
        placementId,
        metricSnapshotId,
        JSON.stringify([id(4005)]),
        draftId,
      ],
    );
    expect(facts.rows[0]).toEqual({
      opportunity: "1",
      draft: "1",
      send_intent: "1",
      reply_assignment: "1",
      placement: "1",
      metric_fact: "1",
    });
  }, 180_000);
});
