import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { finalizeRecommendationGeneration } from "../../../src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.js";
import { createRecommendationPoolV2CutoverService } from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-cutover.service.js";
import { createRecommendationPoolV2CutoverRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-cutover.repository.js";
import { createRecommendationUserReleaseRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = Readonly<{
  rows: Record<string, unknown>[];
  rowCount: number | null;
}>;
type Client = Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}>;
type Pool = BacklinkTenantPool &
  Readonly<{
    end(): Promise<void>;
    query(
      text: string,
      values?: readonly unknown[],
    ): Promise<BacklinkTransactionQueryResult>;
  }>;
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{
    migrationId: string;
    path: string;
  }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => Pool;
};
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );

const organizationId = "99100000-0000-4000-8000-000000000001";
const workspaceId = "99100000-0000-4000-8000-000000000002";
const websiteProjectId = "99100000-0000-4000-8000-000000000003";
const contextId = "99100000-0000-4000-8000-000000000004";
const legacyContextId = "99100000-0000-4000-8000-000000000005";
const outreachProfileId = "99100000-0000-4000-8000-000000000006";
const inputPinId = "99100000-0000-4000-8000-000000000007";
const v1GenerationId = "99100000-0000-4000-8000-000000000008";
const v2GenerationId = "99100000-0000-4000-8000-000000000009";
const projectContractId = "99100000-0000-4000-8000-000000000010";
const prospectId = "99100000-0000-4000-8000-000000000011";
const recommendationId = "99100000-0000-4000-8000-000000000012";
const inventoryId = "99100000-0000-4000-8000-000000000013";
const blueprintId = "99100000-0000-4000-8000-000000000014";
const discoveryBatchId = "99100000-0000-4000-8000-000000000015";
const candidateId = "99100000-0000-4000-8000-000000000016";
const qualificationFactId = "99100000-0000-4000-8000-000000000017";
const visibilityFactId = "99100000-0000-4000-8000-000000000018";
const contactFactId = "99100000-0000-4000-8000-000000000019";
const historicalV2GenerationId = "99100000-0000-4000-8000-000000000021";
const historicalBatchId = "99100000-0000-4000-8000-000000000022";
const historicalItemId = "99100000-0000-4000-8000-000000000023";
const opportunityId = "99100000-0000-4000-8000-000000000024";
const contactBatchId = "99100000-0000-4000-8000-000000000025";
const contactJobId = "99100000-0000-4000-8000-000000000026";
const legacyLineageFactId = "99100000-0000-4000-8000-000000000027";
const visibilityQualificationFactId = "99100000-0000-4000-8000-000000000028";
const compatibilityQualificationFactId = "99100000-0000-4000-8000-000000000029";
const compatibilityVisibilityFactId = "99100000-0000-4000-8000-000000000030";
const actor = "recommendation-pool-v2-cutover-integration";

async function providerCounts(client: Client) {
  return (
    await client.query(`
      SELECT
        (SELECT count(*)::integer FROM backlinks.provider_batch_requests)
          AS "requestCount",
        (SELECT count(*)::integer
           FROM backlinks.backlink_provider_usage_ledger)
          AS "reservationCount",
        (SELECT count(*)::integer FROM backlinks.provider_fetch_leases)
          AS "leaseCount"
    `)
  ).rows[0];
}

describe("recommendation pool V2 cutover", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: Pool;
  let migration0084: string;
  let migration0085: string;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    for (const step of manifest.steps.filter(
      ({ migrationId }) =>
        migrationId === "backlinks-0084" || migrationId === "backlinks-0085",
    )) {
      const migration = await readFile(migrationUrl(step.path), "utf8");
      if (step.migrationId === "backlinks-0085") {
        migration0085 = migration;
        continue;
      }
      if (step.migrationId === "backlinks-0084") {
        migration0084 = migration;
        continue;
      }
    }
    await installBacklinksManifestAfterFoundation(client, "0083");
    pool = new PgPool({
      connectionString: harness.connectionString,
      max: 8,
      options: "-c search_path=backlinks,pg_catalog",
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("projects terminal history and activates without a Phase 9 global freeze", async () => {
    await client.query(
      `INSERT INTO backlinks.backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1,$2,$3,$4,'profile-v1','target-v1',
         '["technical seo"]'::jsonb,'["seo platform"]'::jsonb,
         '["https://project.example.test/product"]'::jsonb,
         '["publishers"]'::jsonb,'["editorial review"]'::jsonb,
         'US','United States','en','["shared-seo-evidence"]'::jsonb,
         'cutover-profile-v1',$5
       )`,
      [outreachProfileId, organizationId, workspaceId, websiteProjectId, actor],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_generation_input_pins (
         id, organization_id, workspace_id, website_project_id,
         project_context_version, site_profile_version_id,
         outreach_profile_version_id, promotion_target_version_id,
         keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
         market, qualification_contract_version, immutable_fingerprint,
         created_by
       ) VALUES (
         $1,$2,$3,$4,7,'site-profile-v1',$5,'target-v1',
         '[]'::jsonb,'[]'::jsonb,'US',
         'recommendation-qualification.v1','cutover-input-pin-v1',$6
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        websiteProjectId,
        outreachProfileId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_project_context_snapshots (
         id, organization_id, workspace_id, website_project_id,
         snapshot_version, project_status, canonical_domain, locale,
         country_code, profile_version_id, promotion_target_version_id,
         products, keywords, target_urls, target_audiences, created_by
       ) VALUES (
         $1,$2,$3,$4,6,'PAUSED','project.example.test','en-US','US',
         'site-profile-v1','target-v1','["seo platform"]'::jsonb,
         '["technical seo"]'::jsonb,
         '["https://project.example.test/product"]'::jsonb,
         '["publishers"]'::jsonb,$6
       ), (
         $5,$2,$3,$4,7,'ACTIVE','project.example.test','en-US','US',
         'site-profile-v1','target-v1','["seo platform"]'::jsonb,
         '["technical seo"]'::jsonb,
         '["https://project.example.test/product"]'::jsonb,
         '["publishers"]'::jsonb,$6
       )`,
      [
        legacyContextId,
        organizationId,
        workspaceId,
        websiteProjectId,
        contextId,
        actor,
      ],
    );

    const insertGeneration = async (
      id: string,
      recommendationContextVersionId: string,
      visiblePoolGeneration: number,
      v2: boolean,
    ) =>
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, qualification_contract_version,
         visibility_contract_version, score_model_version, metric_scope,
         market, location, language, traffic_location_code,
         traffic_language_code, request_fingerprints,
         creator_worker_contract_version, created_by
         ${
           v2
             ? `, pool_contract_version, seed_contract_version,
                  release_contract_version, recommendation_marker_version,
                  discovery_budget_policy_version`
             : ""
         }
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'recommendation-qualification.v1',
         'recommendation-visibility.v1','recommendation-commercial-fit.v4',
         'TARGET_MARKET','US','United States','en',2840,'en','{}'::jsonb,
         'recommendation-qualification.v1',$8
         ${
           v2
             ? `, 'recommendation-pool.v2', 'recommendation-seed.v2',
                  'recommendation-release.v2', 'recommendation-marker.v2',
                  'recommendation-discovery-budget.v1'`
             : ""
         }
       )`,
        [
          id,
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId,
          visiblePoolGeneration,
          inputPinId,
          actor,
        ],
      );
    await insertGeneration(v1GenerationId, legacyContextId, 1, false);
    await insertGeneration(v2GenerationId, contextId, 2, true);
    await insertGeneration(historicalV2GenerationId, contextId, 1, true);
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, activated_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation-pool.v1','V1_ACTIVE',
         NULL,NULL,NULL,NULL,NULL,$5,$5
       )`,
      [projectContractId, organizationId, workspaceId, websiteProjectId, actor],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_prospects (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, hostname_ascii,
         registrable_domain, normalization_version, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,'legacy.publisher.test','publisher.test',
         'tldts-v1',$6,$6
       )`,
      [
        prospectId,
        organizationId,
        workspaceId,
        websiteProjectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendations (
         id, organization_id, workspace_id, website_project_id, prospect_id,
         recommendation_context_version_id, status, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'shown',$7,$7)`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_inventory (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         visible_pool_generation, status, default_contact_source_url,
         created_by, updated_by
       ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,1,'shown',
         'https://legacy.publisher.test/contact',$8,$8
       )`,
      [
        inventoryId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_opportunities (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         target_site_key, target_host_ascii, target_identity_rule_version,
         join_sequence, business_stage, management_status,
         outcome_status, fulfillment_status, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'publisher.test','legacy.publisher.test',
         'tldts-v1',1,'READY_TO_CONTACT','ARCHIVED',
         'OPEN','NOT_EXPECTED',$8,$8
       )`,
      [
        opportunityId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
         id, organization_id, workspace_id, website_project_id,
         project_context_version_id, blueprint_version, generator,
         schema_version, prompt_version, rule_version, blueprint,
         evidence_refs, generated_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK',
         'recommendation-blueprint.v2','recommendation-seed.v2',
         'recommendation-discovery.v2','{}'::jsonb,'[]'::jsonb,
         statement_timestamp(),$6
       )`,
      [
        blueprintId,
        organizationId,
        workspaceId,
        websiteProjectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_batches (
         id, organization_id, workspace_id, website_project_id, blueprint_id,
         project_context_version_id, status, idempotency_key, request_intent,
         source_types, provider_request_fingerprints, paid_cost_micros,
         started_at, finished_at, created_by, visible_pool_generation,
         raw_candidate_count, eligible_candidate_count
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'completed','cutover-existing-history-v1',
         'DISCOVERY','["EXISTING_HISTORY"]'::jsonb,'[]'::jsonb,0,
          statement_timestamp(),statement_timestamp(),$7,1,1,1
       )`,
      [
        discoveryBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_candidates (
         id, organization_id, workspace_id, website_project_id, blueprint_id,
         discovery_batch_id, recommendation_id, prospect_id,
         project_context_version_id, canonical_domain, source_types,
         static_assessment, gate_decision, commercial_score,
         score_model_version, state, provider_collected_at,
         created_by, updated_by, visible_pool_generation
       ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,'publisher.test',
         '["EXISTING_HISTORY"]'::jsonb,'{}'::jsonb,
         '{"decision":"eligible","hitGates":[],"missingEvidence":[]}'::jsonb,
          '{
            "decision":"eligible",
            "total":72,
            "details":{
              "reasonCodes":["DOMAIN_MATCH","TRAFFIC_SIGNAL","AUTHORITY_SIGNAL"]
            },
            "components":[
              {"id":"evidence_completeness","normalizedValue":0.9}
            ],
            "primaryCategory":"editorial",
            "scoreModelVersion":"recommendation-commercial-fit.v4",
           "ruleVersion":"recommendation-commercial-fit-rules.v4.2",
           "admission":{"appliedThreshold":50}
         }'::jsonb,
         'recommendation-commercial-fit.v4','candidate_ready',
          statement_timestamp(),$10,$10,1
       )`,
      [
        candidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        discoveryBatchId,
        recommendationId,
        prospectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_qualification_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         candidate_id, recommendation_id, prospect_id, canonical_domain,
         metric_scope, traffic_organic_etv, spam_score, authority_rank,
         accessibility_decision, semantic_score, attempt, decision,
         decision_reason_code, score_model_version, rule_version,
         fact_contract_version, worker_contract_version,
          request_fingerprints, evidence, observed_at, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,NULL,NULL,'publisher.test',
         'TARGET_MARKET',45000,3,70,'accessible',80,2,'eligible','QUALIFIED',
         'recommendation-commercial-fit.v4',
         'recommendation-commercial-fit-rules.v4.2',
         'recommendation-qualification.v1','recommendation-qualification.v1',
         '{}'::jsonb,'{}'::jsonb,'2026-08-28T00:00:00.000Z',$8
       )`,
      [
        qualificationFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        candidateId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_qualification_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         candidate_id, recommendation_id, prospect_id, canonical_domain,
         metric_scope, traffic_organic_etv, spam_score, authority_rank,
         accessibility_decision, semantic_score, attempt, decision,
         decision_reason_code, score_model_version, rule_version,
         fact_contract_version, worker_contract_version,
         request_fingerprints, evidence, observed_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'publisher.test',
         'TARGET_MARKET',45000,3,70,'accessible',80,1,'eligible','QUALIFIED',
         'recommendation-commercial-fit.v4',
         'recommendation-commercial-fit-rules.v4.2',
         'recommendation-qualification.v1','recommendation-qualification.v1',
         '{}'::jsonb,
         '{"source":"0083-compatible-lineage"}'::jsonb,
         '2026-08-27T23:59:59.000Z',$10
       )`,
      [
        compatibilityQualificationFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        candidateId,
        recommendationId,
        prospectId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_qualification_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         candidate_id, recommendation_id, prospect_id, canonical_domain,
         metric_scope, traffic_organic_etv, spam_score, authority_rank,
         accessibility_decision, semantic_score, attempt, decision,
         decision_reason_code, score_model_version, rule_version,
         fact_contract_version, worker_contract_version,
         request_fingerprints, evidence, observed_at, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,NULL,$7,$8,'publisher.test',
         'TARGET_MARKET',45000,3,70,'accessible',80,3,'eligible','QUALIFIED',
         'recommendation-commercial-fit.v4',
         'recommendation-commercial-fit-rules.v4.2',
         'recommendation-qualification.v1','recommendation-qualification.v1',
         '{}'::jsonb,
         '{"source":"visible-recommendation-attempt"}'::jsonb,
         '2026-08-28T00:00:00.500Z',$9
       )`,
      [
        visibilityQualificationFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        recommendationId,
        prospectId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_visibility_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         qualification_fact_id, recommendation_id, prospect_id,
         canonical_domain, decision, decision_reason_code, attempt,
         rule_version, fact_contract_version, worker_contract_version,
         evidence, observed_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'publisher.test',
         'visible','VISIBLE_FOR_RECOMMENDATION',1,
         'recommendation-visibility-rules.v1',
         'recommendation-visibility.v1','recommendation-qualification.v1',
         '{"source":"0083-compatible-lineage"}'::jsonb,
         '2026-08-27T23:59:59.500Z',$10
       )`,
      [
        compatibilityVisibilityFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        compatibilityQualificationFactId,
        recommendationId,
        prospectId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_visibility_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         qualification_fact_id, recommendation_id, prospect_id,
         canonical_domain, decision, decision_reason_code, attempt,
         rule_version, fact_contract_version, worker_contract_version,
         evidence, observed_at, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,'publisher.test',
          'visible','VISIBLE_FOR_RECOMMENDATION',2,
          'recommendation-visibility-rules.v1',
          'recommendation-visibility.v1','recommendation-qualification.v1',
         '{}'::jsonb,'2026-08-28T00:00:01.000Z',$10
       )`,
      [
        visibilityFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        visibilityQualificationFactId,
        recommendationId,
        prospectId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_contact_facts (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         recommendation_id, prospect_id, canonical_domain, decision,
         decision_reason_code, attempt, fact_contract_version,
         worker_contract_version, evidence, observed_at, created_by
       ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'publisher.test',
          'pending','CONTACT_PENDING',1,
          'recommendation-qualification.v1','recommendation-qualification.v1',
         '{"source":"persisted-history"}'::jsonb,
         '2026-08-28T00:00:02.000Z',$9
       )`,
      [
        contactFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v1GenerationId,
        legacyContextId,
        recommendationId,
        prospectId,
        actor,
      ],
    );

    const completedAt = new Date("2026-08-28T00:00:03.000Z");
    const finalized = finalizeRecommendationGeneration({
      candidates: [
        {
          id: candidateId,
          recommendationId,
          prospectId,
          inventoryId,
          generationContractId: v2GenerationId,
          inputPinId,
          recommendationContextVersionId: contextId,
          canonicalDomain: "publisher.test",
          recommended: true,
          recommendationReasonStrengthBand: 3,
          evidenceCompleteness: 0.9,
        },
      ],
      terminalReason: "PATHS_EXHAUSTED",
      completedAt,
    });
    await client.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=$2,
              canonical_batch_size=$3,
              canonical_batch_count=$4,
              canonical_order_fingerprint=$5,
              discovery_terminal_reason=$6,
              discovery_completed_at=$7
        WHERE id=$1`,
      [
        v2GenerationId,
        finalized.effectiveUniqueCandidateCount,
        finalized.canonicalBatchSize,
        finalized.canonicalBatchCount,
        finalized.canonicalOrderFingerprint,
        finalized.discoveryTerminalReason,
        finalized.discoveryCompletedAt,
      ],
    );

    const repository = createRecommendationPoolV2CutoverRepository(pool);
    const service = createRecommendationPoolV2CutoverService(repository);
    const providersBefore = await providerCounts(client);

    const pendingPlan = await service.run({
      commandId: "cutover-contact-pending-plan-v1",
      mode: "PLAN",
      actor,
    });
    expect(pendingPlan).toMatchObject({
      status: "MIGRATION_BLOCKED",
      facts: [
        {
          result: "MIGRATION_BLOCKED",
          reasonCodes: ["CONTACT_PENDING"],
        },
      ],
    });
    const pendingApply = await service.run({
      commandId: "cutover-contact-pending-apply-v1",
      mode: "EXECUTE",
      actor,
    });
    expect(pendingApply).toMatchObject({
      status: "MIGRATION_BLOCKED",
      facts: [
        {
          result: "MIGRATION_BLOCKED",
          reasonCodes: ["CONTACT_PENDING"],
        },
      ],
      verification: {
        completed: false,
        activeV1ProjectCount: 0,
        migrationBlockedProjectCount: 1,
      },
    });
    expect(
      (
        await client.query(
          `SELECT contract.pool_contract_version AS "poolContractVersion",
                  contract.migration_state AS "migrationState",
                  (SELECT count(*)::integer
                     FROM backlinks.backlink_recommendation_release_batches
                    WHERE organization_id=$2 AND workspace_id=$3
                      AND website_project_id=$4) AS "batchCount",
                  (SELECT count(*)::integer
                     FROM backlinks.backlink_recommendation_user_publications
                    WHERE organization_id=$2 AND workspace_id=$3
                      AND website_project_id=$4) AS "publicationCount"
             FROM backlinks.backlink_recommendation_pool_project_contracts
               AS contract
            WHERE contract.id=$1`,
          [projectContractId, organizationId, workspaceId, websiteProjectId],
        )
      ).rows,
    ).toEqual([
      {
        poolContractVersion: "recommendation-pool.v1",
        migrationState: "MIGRATION_BLOCKED",
        batchCount: 0,
        publicationCount: 0,
      },
    ]);
    expect(await providerCounts(client)).toEqual(providersBefore);

    await client.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_batches (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, status,
         started_at, completed_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,'completed',
         '2026-08-28T00:00:03.000Z','2026-08-28T00:00:04.000Z',$6,$6
       )`,
      [
        contactBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        legacyContextId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_jobs (
         id, organization_id, workspace_id, website_project_id, batch_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         root_url, status, method, terminal_reason_code,
         started_at, finished_at, completed_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'https://legacy.publisher.test/contact',
          'partially_completed','static','MANUAL_REVIEW_REQUIRED',
          '2026-08-28T00:00:03.000Z','2026-08-28T00:00:04.123456Z',
          '2026-08-28T00:00:04.123456Z',$9,$9
       )`,
      [
        contactJobId,
        organizationId,
        workspaceId,
        websiteProjectId,
        contactBatchId,
        recommendationId,
        prospectId,
        legacyContextId,
        actor,
      ],
    );

    const historyBefore = (
      await client.query(
        `SELECT recommendation.status AS "recommendationStatus",
                inventory.status AS "inventoryStatus",
                opportunity.business_stage AS "businessStage",
                opportunity.management_status AS "managementStatus",
                opportunity.outcome_status AS "outcomeStatus",
                opportunity.fulfillment_status AS "fulfillmentStatus",
                opportunity.version AS "opportunityVersion"
           FROM backlinks.backlink_recommendations AS recommendation
           JOIN backlinks.backlink_recommendation_inventory AS inventory
             ON inventory.recommendation_id=recommendation.id
           JOIN backlinks.backlink_opportunities AS opportunity
             ON opportunity.recommendation_id=recommendation.id
          WHERE recommendation.id=$1`,
        [recommendationId],
      )
    ).rows;

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         batch_ordinal, state, original_batch_size,
         selection_policy_version, order_fingerprint,
         contact_terminal_count, contact_total_count,
         preparation_started_at, available_at, deadline_at,
         created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,1,$7,'recommendation-pool.v2',
         1,'PREPARING',1,'recommendation-batch-selection.v1',
         'historical-release-order-v1',0,1,
         '2026-08-27T00:00:00.000Z',NULL,
         '2026-08-27T18:00:00.000Z',$8,$8
       )`,
      [
        historicalBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        historicalV2GenerationId,
        contextId,
        inputPinId,
        actor,
      ],
    );
    const legacyMetricSnapshot = JSON.stringify({
      value: null,
      provider: "growthos",
      endpoint: "legacy-import",
      market: "US",
      location: "United States",
      language: "en",
      observedAt: "2026-08-27T00:00:00.000Z",
      artifactRef: "legacy-release:publisher.test",
    });
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
         id, organization_id, workspace_id, website_project_id, batch_id,
         recommendation_context_version_id, visible_pool_generation,
         generation_contract_id, input_pin_id, pool_contract_version,
         canonical_domain, position, recommended,
         recommendation_reason_codes, recommendation_marker_version,
         traffic_snapshot, rank_snapshot, spam_snapshot,
         contact_terminal_reason_at_release,
         contact_completed_at_release, legacy_imported, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,1,$7,$8,'recommendation-pool.v2',
          'publisher.test',1,true,'["HISTORICAL_RELEASE"]'::jsonb,
          'recommendation-marker.v2',$9::jsonb,$9::jsonb,$9::jsonb,
           'MANUAL_REVIEW_REQUIRED','2026-08-28T00:00:04.123456Z',true,$10
       )`,
      [
        historicalItemId,
        organizationId,
        workspaceId,
        websiteProjectId,
        historicalBatchId,
        contextId,
        historicalV2GenerationId,
        inputPinId,
        legacyMetricSnapshot,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO
         backlinks.backlink_recommendation_legacy_source_lineage_facts (
           id, organization_id, workspace_id, website_project_id,
           target_generation_contract_id,
           target_recommendation_context_version_id,
           target_visible_pool_generation, target_input_pin_id,
           target_batch_id, target_item_id, target_pool_contract_version,
           source_generation_contract_id,
           source_recommendation_context_version_id,
           source_visible_pool_generation, source_input_pin_id,
           source_pool_contract_version, source_candidate_id,
           source_recommendation_id, source_prospect_id, source_inventory_id,
           source_qualification_fact_id, source_visibility_fact_id,
           source_contact_enrichment_job_id, canonical_domain,
           contact_terminal_reason, contact_completed_at, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,1,$7,$8,$9,'recommendation-pool.v2',
           $10,$11,1,$7,'recommendation-pool.v1',$12,$13,$14,$15,
           $16,$17,$18,'publisher.test','MANUAL_REVIEW_REQUIRED',
            '2026-08-28T00:00:04.123456Z',$19
         )`,
      [
        legacyLineageFactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        historicalV2GenerationId,
        contextId,
        inputPinId,
        historicalBatchId,
        historicalItemId,
        v1GenerationId,
        legacyContextId,
        candidateId,
        recommendationId,
        prospectId,
        inventoryId,
        compatibilityQualificationFactId,
        compatibilityVisibilityFactId,
        contactJobId,
        actor,
      ],
    );
    await client.query(migration0084);
    expect(
      (
        await client.query(
          `SELECT source_qualification_fact_id::text
                    AS "sourceQualificationFactId",
                  source_candidate_qualification_fact_id::text
                    AS "sourceCandidateQualificationFactId",
                  source_visibility_qualification_fact_id::text
                    AS "sourceVisibilityQualificationFactId",
                  source_visibility_fact_id::text AS "sourceVisibilityFactId"
             FROM backlinks.
               backlink_recommendation_legacy_source_lineage_facts
            WHERE id=$1`,
          [legacyLineageFactId],
        )
      ).rows,
    ).toEqual([
      {
        sourceQualificationFactId: compatibilityQualificationFactId,
        sourceCandidateQualificationFactId: compatibilityQualificationFactId,
        sourceVisibilityQualificationFactId: compatibilityQualificationFactId,
        sourceVisibilityFactId: compatibilityVisibilityFactId,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               lineage
             ) AS valid,
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'source_candidate_qualification_fact_id',
                     NULL
                   )
               )
             ) AS "missingCandidateQualification",
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'source_visibility_qualification_fact_id',
                     $2::text
                   )
               )
             ) AS "visibilityQualificationMismatch",
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'organization_id',
                     '99100000-0000-4000-8000-000000000098'
                   )
               )
             ) AS "crossScope",
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'source_recommendation_context_version_id',
                     $3::text
                   )
               )
             ) AS "crossContext",
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'source_generation_contract_id',
                     $4::text
                   )
               )
             ) AS "crossGeneration",
             backlinks.backlink_recommendation_legacy_source_lineage_is_valid(
               jsonb_populate_record(
                 NULL::backlinks.
                   backlink_recommendation_legacy_source_lineage_facts,
                 to_jsonb(lineage) ||
                   jsonb_build_object(
                     'canonical_domain',
                     'cross-domain.test'
                   )
               )
             ) AS "crossDomain"
            FROM backlinks.
              backlink_recommendation_legacy_source_lineage_facts AS lineage
           WHERE lineage.id=$1`,
          [
            legacyLineageFactId,
            qualificationFactId,
            contextId,
            historicalV2GenerationId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        valid: true,
        missingCandidateQualification: false,
        visibilityQualificationMismatch: false,
        crossScope: false,
        crossContext: false,
        crossGeneration: false,
        crossDomain: false,
      },
    ]);
    await expect(
      client.query(
        `UPDATE backlinks.
           backlink_recommendation_legacy_source_lineage_facts
            SET source_visibility_qualification_fact_id=$2
          WHERE id=$1`,
        [legacyLineageFactId, visibilityQualificationFactId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=1,
              available_at='2026-08-27T00:00:01.000Z',
              updated_at=statement_timestamp(),
              updated_by=$2,
              version=version+1
        WHERE id=$1`,
      [historicalBatchId, actor],
    );

    const duplicatePlan = await service.run({
      commandId: "cutover-duplicate-domain-plan-v1",
      mode: "PLAN",
      actor,
    });
    expect(duplicatePlan).toMatchObject({
      status: "MIGRATION_BLOCKED",
      facts: [
        {
          result: "MIGRATION_BLOCKED",
          reasonCodes: ["LEGACY_DOMAIN_ALREADY_RELEASED"],
        },
      ],
    });
    const duplicateApply = await service.run({
      commandId: "cutover-duplicate-domain-apply-v1",
      mode: "EXECUTE",
      actor,
    });
    expect(duplicateApply).toMatchObject({
      status: "MIGRATION_BLOCKED",
      facts: [
        {
          result: "MIGRATION_BLOCKED",
          reasonCodes: ["LEGACY_DOMAIN_ALREADY_RELEASED"],
        },
      ],
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
            FROM backlinks.backlink_recommendation_release_batch_items
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3
              AND canonical_domain='publisher.test'`,
          [organizationId, workspaceId, websiteProjectId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(await providerCounts(client)).toEqual(providersBefore);

    await client.query("SET session_replication_role = replica");
    try {
      await client.query(
        `DELETE FROM
           backlinks.backlink_recommendation_legacy_source_lineage_facts
         WHERE id=$1`,
        [legacyLineageFactId],
      );
      await client.query(
        `DELETE FROM backlinks.backlink_recommendation_release_batch_items
          WHERE id=$1`,
        [historicalItemId],
      );
      await client.query(
        `DELETE FROM backlinks.backlink_recommendation_release_batches
          WHERE id=$1`,
        [historicalBatchId],
      );
      await client.query(
        `DELETE FROM backlinks.backlink_recommendation_generation_contracts
          WHERE id = ANY($1::uuid[])`,
        [[v2GenerationId, historicalV2GenerationId]],
      );
    } finally {
      await client.query("SET session_replication_role = origin");
    }
    await client.query(
      `UPDATE backlinks.backlink_recommendation_pool_project_contracts
          SET pool_contract_version='recommendation-pool.v2',
              migration_state='V2_READY',
              updated_at=clock_timestamp(),
              updated_by=$2,
              version=version+1
        WHERE id=$1`,
      [projectContractId, actor],
    );

    const planned = await service.run({
      commandId: "cutover-plan-v1",
      mode: "PLAN",
      actor,
    });
    expect(planned).toMatchObject({
      status: "PLANNED",
      facts: [
        {
          result: "READY",
          reasonCodes: ["TERMINAL_LEGACY_PROJECTION_READY"],
        },
      ],
    });
    expect(await providerCounts(client)).toEqual(providersBefore);
    expect(
      (
        await client.query(
          `SELECT recommendation.status AS "recommendationStatus",
                  inventory.status AS "inventoryStatus",
                  opportunity.business_stage AS "businessStage",
                  opportunity.management_status AS "managementStatus",
                  opportunity.outcome_status AS "outcomeStatus",
                  opportunity.fulfillment_status AS "fulfillmentStatus",
                  opportunity.version AS "opportunityVersion"
             FROM backlinks.backlink_recommendations AS recommendation
             JOIN backlinks.backlink_recommendation_inventory AS inventory
               ON inventory.recommendation_id=recommendation.id
             JOIN backlinks.backlink_opportunities AS opportunity
               ON opportunity.recommendation_id=recommendation.id
            WHERE recommendation.id=$1`,
          [recommendationId],
        )
      ).rows,
    ).toEqual(historyBefore);

    const factsBeforeScopeFailures = (
      await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM backlinks.backlink_recommendation_release_batches
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3) AS "batchCount",
           (SELECT count(*)::integer
              FROM backlinks.backlink_recommendation_release_batch_items
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3) AS "itemCount"`,
        [organizationId, workspaceId, websiteProjectId],
      )
    ).rows;
    await expect(
      repository.planProject({
        organizationId,
        workspaceId,
        websiteProjectId,
        projectContextSnapshotId: contextId,
        projectContextSnapshotVersion: 6,
      }),
    ).resolves.toMatchObject({
      result: "MIGRATION_BLOCKED",
      lineage: null,
    });
    await expect(
      repository.planProject({
        organizationId,
        workspaceId,
        websiteProjectId: "99100000-0000-4000-8000-000000000099",
        projectContextSnapshotId: "99100000-0000-4000-8000-000000000098",
        projectContextSnapshotVersion: 7,
      }),
    ).resolves.toMatchObject({
      result: "MIGRATION_BLOCKED",
      lineage: null,
    });
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_release_batches
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3) AS "batchCount",
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_release_batch_items
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3) AS "itemCount"`,
          [organizationId, workspaceId, websiteProjectId],
        )
      ).rows,
    ).toEqual(factsBeforeScopeFailures);
    expect(await providerCounts(client)).toEqual(providersBefore);

    const concurrent = await Promise.all([
      service.run({
        commandId: "cutover-execute-v1",
        mode: "EXECUTE",
        actor,
      }),
      service.run({
        commandId: "cutover-execute-v1",
        mode: "EXECUTE",
        actor,
      }),
    ]);
    expect(new Set(concurrent.map(({ runId }) => runId)).size).toBe(1);
    expect(concurrent.some(({ status }) => status === "COMPLETED")).toBe(true);

    const replayed = await service.run({
      commandId: "cutover-execute-v1",
      mode: "EXECUTE",
      actor,
    });
    expect(replayed.status).toBe("COMPLETED");
    expect(replayed.facts).toHaveLength(1);
    expect(replayed.facts[0]).toMatchObject({
      result: "V2_ACTIVE",
      canonicalBatchCount: 1,
      availableBatchCount: 1,
      canonicalItemCount: 1,
    });

    const migrationGeneration = (
      await client.query<{
        id: string;
        recommendationContextVersionId: string;
        inputPinId: string;
        visiblePoolGeneration: number;
        effectiveUniqueCandidateCount: number;
        canonicalBatchSize: number;
        canonicalBatchCount: number;
        completed: boolean;
        discoveryIntentCount: number;
        discoveryOutcomeCount: number;
        discoveryWindowCount: number;
        discoveryRoundCount: number;
        discoveryTerminalCount: number;
      }>(
        `SELECT generation.id::text AS id,
                generation.recommendation_context_version_id::text
                  AS "recommendationContextVersionId",
                generation.input_pin_id::text AS "inputPinId",
                generation.visible_pool_generation AS "visiblePoolGeneration",
                generation.effective_unique_candidate_count
                  AS "effectiveUniqueCandidateCount",
                generation.canonical_batch_size AS "canonicalBatchSize",
                generation.canonical_batch_count AS "canonicalBatchCount",
                (generation.discovery_completed_at IS NOT NULL) AS completed,
                (SELECT count(*)::integer
                   FROM backlinks.backlink_recommendation_discovery_request_intents
                  WHERE generation_contract_id=generation.id)
                  AS "discoveryIntentCount",
                (SELECT count(*)::integer
                   FROM backlinks.backlink_recommendation_discovery_request_outcomes
                  WHERE generation_contract_id=generation.id)
                  AS "discoveryOutcomeCount",
                (SELECT count(*)::integer
                   FROM backlinks.backlink_recommendation_discovery_window_facts
                  WHERE generation_contract_id=generation.id)
                  AS "discoveryWindowCount",
                (SELECT count(*)::integer
                   FROM backlinks.backlink_recommendation_discovery_round_facts
                  WHERE generation_contract_id=generation.id)
                  AS "discoveryRoundCount",
                (SELECT count(*)::integer
                   FROM backlinks.backlink_recommendation_discovery_generation_terminal_facts
                  WHERE generation_contract_id=generation.id)
                  AS "discoveryTerminalCount"
           FROM backlinks.backlink_recommendation_generation_contracts
             AS generation
          WHERE generation.organization_id=$1
            AND generation.workspace_id=$2
            AND generation.website_project_id=$3
            AND generation.pool_contract_version='recommendation-pool.v2'`,
        [organizationId, workspaceId, websiteProjectId],
      )
    ).rows;
    expect(migrationGeneration).toEqual([
      {
        id: expect.any(String),
        recommendationContextVersionId: contextId,
        inputPinId,
        visiblePoolGeneration: 2,
        effectiveUniqueCandidateCount: 1,
        canonicalBatchSize: 1,
        canonicalBatchCount: 1,
        completed: true,
        discoveryIntentCount: 0,
        discoveryOutcomeCount: 0,
        discoveryWindowCount: 0,
        discoveryRoundCount: 0,
        discoveryTerminalCount: 0,
      },
    ]);
    const migrationGenerationId = migrationGeneration[0]?.id;
    expect(migrationGenerationId).toBeDefined();
    expect(migrationGenerationId).not.toBe(v1GenerationId);

    expect(
      (
        await client.query(
          `SELECT contract.migration_state AS "migrationState",
                  contract.pool_contract_version AS "poolContractVersion",
                  item.legacy_imported AS "legacyImported",
                  item.candidate_id::text AS "candidateId",
                  item.recommendation_id::text AS "recommendationId",
                  item.prospect_id::text AS "prospectId",
                  item.inventory_id::text AS "inventoryId",
                  item.generation_contract_id::text AS "generationContractId",
                  item.input_pin_id::text AS "inputPinId",
                  item.contact_terminal_reason_at_release AS "contactReason",
                  item.contact_email_at_release AS "contactEmail",
                  batch.state AS "batchState",
                  lineage.source_pool_contract_version AS "sourceContract",
                  lineage.target_pool_contract_version AS "targetContract",
                  lineage.source_candidate_id::text AS "sourceCandidateId",
                  lineage.source_recommendation_id::text
                    AS "sourceRecommendationId",
                  lineage.source_prospect_id::text AS "sourceProspectId",
                   lineage.source_inventory_id::text AS "sourceInventoryId",
                   lineage.source_qualification_fact_id::text
                     AS "sourceQualificationFactId",
                   lineage.source_candidate_qualification_fact_id::text
                     AS "sourceCandidateQualificationFactId",
                   lineage.source_visibility_qualification_fact_id::text
                     AS "sourceVisibilityQualificationFactId",
                   lineage.source_visibility_fact_id::text
                     AS "sourceVisibilityFactId",
                   lineage.canonical_domain AS "lineageDomain",
                  lineage.contact_terminal_reason AS "lineageContactReason"
             FROM backlinks.backlink_recommendation_pool_project_contracts
               AS contract
             JOIN backlinks.backlink_recommendation_release_batches AS batch
               ON batch.organization_id=contract.organization_id
              AND batch.workspace_id=contract.workspace_id
              AND batch.website_project_id=contract.website_project_id
              AND batch.generation_contract_id=contract.generation_contract_id
             JOIN backlinks.backlink_recommendation_release_batch_items AS item
               ON item.batch_id=batch.id
             JOIN backlinks.backlink_recommendation_legacy_source_lineage_facts
               AS lineage
               ON lineage.organization_id=item.organization_id
              AND lineage.workspace_id=item.workspace_id
              AND lineage.website_project_id=item.website_project_id
              AND lineage.target_item_id=item.id
            WHERE contract.id=$1`,
          [projectContractId],
        )
      ).rows,
    ).toEqual([
      {
        migrationState: "V2_ACTIVE",
        poolContractVersion: "recommendation-pool.v2",
        legacyImported: true,
        candidateId: null,
        recommendationId: null,
        prospectId: null,
        inventoryId: null,
        generationContractId: migrationGenerationId,
        inputPinId,
        contactReason: "MANUAL_REVIEW_REQUIRED",
        contactEmail: null,
        batchState: "AVAILABLE",
        sourceContract: "recommendation-pool.v1",
        targetContract: "recommendation-pool.v2",
        sourceCandidateId: candidateId,
        sourceRecommendationId: recommendationId,
        sourceProspectId: prospectId,
        sourceInventoryId: inventoryId,
        sourceQualificationFactId: qualificationFactId,
        sourceCandidateQualificationFactId: qualificationFactId,
        sourceVisibilityQualificationFactId: visibilityQualificationFactId,
        sourceVisibilityFactId: visibilityFactId,
        lineageDomain: "publisher.test",
        lineageContactReason: "MANUAL_REVIEW_REQUIRED",
      },
    ]);

    const releaseRepository = createRecommendationUserReleaseRepository(pool);
    const releaseScope = {
      organizationId,
      workspaceId,
      websiteProjectId,
      actorId: "phase8-authorized-member",
    };
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_user_publications
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3 AND user_id=$4)
               AS "publicationCount",
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_user_cursors
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3 AND user_id=$4)
               AS "cursorCount"`,
          [
            releaseScope.organizationId,
            releaseScope.workspaceId,
            releaseScope.websiteProjectId,
            releaseScope.actorId,
          ],
        )
      ).rows,
    ).toEqual([{ publicationCount: 0, cursorCount: 0 }]);

    const firstStatus = await releaseRepository.getStatus(releaseScope);
    const replayedStatus = await releaseRepository.getStatus(releaseScope);
    expect(firstStatus).not.toBeNull();
    expect(replayedStatus).toMatchObject({
      currentBatchOrdinal: firstStatus?.currentBatchOrdinal,
      originalBatchSize: firstStatus?.originalBatchSize,
      successfulOpportunityCount: firstStatus?.successfulOpportunityCount,
      firstVisibleAt: firstStatus?.firstVisibleAt,
      previouslyUnlockedAt: firstStatus?.previouslyUnlockedAt,
      previouslyUnlockReason: firstStatus?.previouslyUnlockReason,
      nextBatchState: firstStatus?.nextBatchState,
    });
    expect(replayedStatus?.databaseNow.getTime()).toBeGreaterThanOrEqual(
      firstStatus?.databaseNow.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(firstStatus).toMatchObject({
      currentBatchOrdinal: 1,
      originalBatchSize: 1,
      successfulOpportunityCount: 0,
      nextBatchState: "NONE",
    });
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_user_publications
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3 AND user_id=$4)
               AS "publicationCount",
             (SELECT count(*)::integer
                FROM backlinks.backlink_recommendation_user_cursors
               WHERE organization_id=$1 AND workspace_id=$2
                 AND website_project_id=$3 AND user_id=$4)
               AS "cursorCount"`,
          [
            releaseScope.organizationId,
            releaseScope.workspaceId,
            releaseScope.websiteProjectId,
            releaseScope.actorId,
          ],
        )
      ).rows,
    ).toEqual([{ publicationCount: 1, cursorCount: 1 }]);

    expect(replayed.verification).toMatchObject({
      completed: true,
      eligibleProjectCount: 1,
      v2ActiveProjectCount: 1,
      validV2ActiveProjectCount: 1,
      invalidV2ActiveProjectCount: 0,
      activeV1ProjectCount: 0,
      migrationBlockedProjectCount: 0,
      activeV1GenerationCount: 0,
      activeV1RefillCount: 0,
      activeV1RefillJobCount: 0,
      activeV1OutboxCount: 0,
      activeV1ClaimCount: 0,
      activeV1ProviderRequestCount: 0,
      activeV1ProviderReservationCount: 0,
      activeV1ProviderLeaseCount: 0,
    });
    const verified = await service.run({
      commandId: "cutover-verify-v1",
      mode: "VERIFY",
      actor,
    });
    expect(verified).toMatchObject({
      status: "COMPLETED",
      facts: [],
      verification: replayed.verification,
    });
    expect(await providerCounts(client)).toEqual(providersBefore);
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_pool_v2_cutover_control`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(await providerCounts(client)).toEqual(providersBefore);
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_generation_contracts
            WHERE id=$1
              AND pool_contract_version='recommendation-pool.v1'`,
          [v1GenerationId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    await client.query(migration0085);
    const phase9Plan = (
      await client.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_phase9_run(
           $1::uuid,$2::text,'PLAN',$3::text,clock_timestamp()
         ) AS run`,
        [
          "99100000-0000-4000-8000-000000000031",
          "phase9-cutover-plan-v1",
          actor,
        ],
      )
    ).rows[0]?.run;
    expect(phase9Plan).toMatchObject({
      status: "PLANNED",
      verification: {
        completed: false,
        readyForExecute: true,
        v1WritesFrozen: false,
      },
    });

    const phase9ExecuteQuery = {
      text: `SELECT backlinks.backlink_recommendation_pool_v2_phase9_run(
        $1::uuid,$2::text,'EXECUTE',$3::text,clock_timestamp()
      ) AS run`,
      values: [
        "99100000-0000-4000-8000-000000000032",
        "phase9-cutover-execute-v1",
        actor,
      ],
    } as const;
    const phase9Concurrent = await Promise.all([
      pool.query(phase9ExecuteQuery.text, phase9ExecuteQuery.values),
      pool.query(phase9ExecuteQuery.text, phase9ExecuteQuery.values),
    ]);
    expect(phase9Concurrent.map(({ rows }) => rows[0]?.run)).toEqual([
      expect.objectContaining({
        status: "COMPLETED",
        verification: expect.objectContaining({
          completed: true,
          v1WritesFrozen: true,
          phase9FreezeTriggerCount: 18,
          phase9FreezeTriggersInstalled: true,
        }),
      }),
      expect.objectContaining({
        status: "COMPLETED",
        verification: expect.objectContaining({
          completed: true,
          v1WritesFrozen: true,
          phase9FreezeTriggerCount: 18,
          phase9FreezeTriggersInstalled: true,
        }),
      }),
    ]);

    const phase9Verify = (
      await client.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_phase9_run(
           $1::uuid,$2::text,'VERIFY',$3::text,clock_timestamp()
         ) AS run`,
        [
          "99100000-0000-4000-8000-000000000033",
          "phase9-cutover-verify-v1",
          actor,
        ],
      )
    ).rows[0]?.run;
    expect(phase9Verify).toMatchObject({
      status: "COMPLETED",
      verification: {
        completed: true,
        readyForExecute: true,
        v1WritesFrozen: true,
        v1GenerationHistoryCount: 1,
        phase9FreezeTriggerCount: 18,
        phase9FreezeTriggerExpectedCount: 18,
        phase9FreezeTriggersInstalled: true,
      },
    });

    const phase9Classifiers = (
      await client.query(`
        SELECT
          backlinks.backlink_phase9_job_is_v1('{}'::jsonb)
            AS "missingJob",
          backlinks.backlink_phase9_job_is_v1(
            '{"job_type":"generic","source_object_type":"generic",
              "organization_id":"not-a-uuid","workspace_id":"not-a-uuid",
              "website_project_id":"not-a-uuid",
              "source_object_id":"not-a-uuid"}'::jsonb
          ) AS "malformedJob",
          backlinks.backlink_phase9_outbox_is_v1('{}'::jsonb)
            AS "missingOutbox",
          backlinks.backlink_phase9_idempotency_is_v1('{}'::jsonb)
            AS "missingIdempotency",
          backlinks.backlink_phase9_provider_batch_is_allowed('{}'::jsonb)
            AS "missingProviderBatchAllowed",
          backlinks.backlink_phase9_provider_request_is_allowed('{}'::jsonb)
            AS "missingProviderRequestAllowed",
          backlinks.backlink_phase9_provider_usage_is_allowed('{}'::jsonb)
            AS "missingProviderUsageAllowed",
          backlinks.backlink_phase9_fetch_lease_is_allowed('{}'::jsonb)
            AS "missingProviderLeaseAllowed"
      `)
    ).rows;
    expect(phase9Classifiers).toEqual([
      {
        missingJob: true,
        malformedJob: true,
        missingOutbox: true,
        missingIdempotency: true,
        missingProviderBatchAllowed: false,
        missingProviderRequestAllowed: false,
        missingProviderUsageAllowed: false,
        missingProviderLeaseAllowed: false,
      },
    ]);

    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET created_by=created_by
          WHERE id=$1`,
        [v1GenerationId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendations
            SET updated_by=updated_by
          WHERE id=$1`,
        [recommendationId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        `DELETE FROM backlinks.backlink_recommendation_inventory
          WHERE id=$1`,
        [inventoryId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_pool_v2_cutover_control
            SET frozen_by=frozen_by
          WHERE control_key='GLOBAL'`,
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await client.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET created_by=created_by
        WHERE id=$1`,
      [v2GenerationId],
    );
    expect(await providerCounts(client)).toEqual(providersBefore);

    await service.enterMaintenanceReadOnly({
      organizationId,
      workspaceId,
      websiteProjectId,
      actor,
      reasonCodes: ["EMERGENCY_MAINTENANCE"],
    });
    expect(
      (
        await client.query(
          `SELECT migration_state AS "migrationState"
             FROM backlinks.backlink_recommendation_pool_project_contracts
            WHERE id=$1`,
          [projectContractId],
        )
      ).rows,
    ).toEqual([{ migrationState: "V2_MAINTENANCE_READ_ONLY" }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_pool_v2_cutover_control`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(await providerCounts(client)).toEqual(providersBefore);
  }, 180_000);
});
