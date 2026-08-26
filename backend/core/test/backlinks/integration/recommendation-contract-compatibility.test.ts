import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRecommendationsQuery } from "../../../src/modules/backlinks/application/queries/recommendations.query.js";
import { createProjectInputPersistenceRepository } from "../../../src/modules/backlinks/db/repositories/project-input-persistence.repository.js";
import { createRecommendationContractRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-contract.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
} from "../../../src/modules/backlinks/ports/recommendation-contract.port.js";
import {
  commercialQualificationRuleVersion,
} from "../../../src/modules/backlinks/domain/recommendations/commercial-qualification-v4.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};
type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const migrationsUrl = new URL(
  "../../../src/modules/backlinks/db/migrations/",
  import.meta.url,
);
const migrationUrl = (name: string) => new URL(name, migrationsUrl);
const id = (value: number) =>
  `018f0063-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const recommendationContextVersionId = id(4);
const inputPinId = id(10);
const generationContractId = id(11);
const legacyRecommendationId = id(21);
const correctedRecommendationId = id(31);
const historicalRefillJobId = id(41);
const overlappingRefillJobId = id(42);
const historicalBlueprintId = id(43);
const uniqueHistoricalBatchId = id(44);
const ambiguousHistoricalBatchId = id(45);
const fallbackContextVersionId = id(100);
const fallbackInputPinId = id(101);
const fallbackGenerationContractId = id(102);
const fallbackBlueprintId = id(103);
const fallbackBatchId = id(104);
const fallbackLegacyProspectId = id(105);
const fallbackLegacyRecommendationId = id(106);
const fallbackLegacyInventoryId = id(107);
const fallbackLegacyContactCandidateId = id(108);
const fallbackLegacyContactEvidenceId = id(109);
const fallbackLegacyContactSnapshotId = id(110);
const fallbackLegacyCommercialCandidateId = id(111);
const fallbackV4ProspectId = id(112);
const fallbackV4RecommendationId = id(113);
const fallbackV4InventoryId = id(114);
const fallbackV4CommercialCandidateId = id(115);

const platformProjectFunction = `
  SET ROLE growthos_platform_owner;
  SET search_path = platform, pg_catalog;
  CREATE FUNCTION backlink_list_active_website_projects(text, text)
  RETURNS TABLE (website_project_id text, context_version integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = platform, pg_catalog
  AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
  REVOKE ALL
    ON FUNCTION backlink_list_active_website_projects(text, text)
    FROM PUBLIC;
  GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
  GRANT EXECUTE
    ON FUNCTION backlink_list_active_website_projects(text, text)
    TO growthos_backlinks_owner;
  RESET ROLE;
  RESET search_path;
`;

async function migrationNames(): Promise<string[]> {
  return (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

async function applyMigrations(
  client: RuntimeClient,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    try {
      await client.query(await readFile(migrationUrl(name), "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${name} failed: ${message}`, { cause: error });
    }
  }
}

async function seedProjectInputsAndLegacyV3(client: RuntimeClient): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id, organization_id, workspace_id, website_project_id,
       profile_version_id, promotion_target_version_id,
       keywords_and_topics, products_and_services, target_urls,
       target_audiences, partnership_goals, market, location, language,
       authorized_discovery_sources, immutable_fingerprint, created_by
     ) VALUES (
       $1, $2, $3, $4, 'profile-v1', 'promotion-v1',
       '["technical seo"]'::jsonb, '["seo audit"]'::jsonb,
       '["https://owner.test/audit"]'::jsonb, '["site owners"]'::jsonb,
       '["editorial mention"]'::jsonb, 'US', 'United States', 'en',
       '["shared-seo-evidence"]'::jsonb, 'profile-fingerprint',
       'phase-2-integration'
     )`,
    [id(9), organizationId, workspaceId, websiteProjectId],
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
       $1, $2, $3, $4, 1, 'site-profile-v1', $5, 'promotion-v1',
       '["keyword-snapshot-1"]'::jsonb, '[]'::jsonb, 'US',
       $6, 'input-pin-fingerprint', 'phase-2-integration'
     )`,
    [
      inputPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      id(9),
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_prospects (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, hostname_ascii,
       registrable_domain, normalization_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'legacy.test', 'legacy.test',
       'tldts-v1', 'phase-2-integration', 'phase-2-integration'
     )`,
    [
      id(20),
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendations (
       id, organization_id, workspace_id, website_project_id, prospect_id,
       recommendation_context_version_id, status, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'ready',
       'phase-2-integration', 'phase-2-integration'
     )`,
    [
      legacyRecommendationId,
      organizationId,
      workspaceId,
      websiteProjectId,
      id(20),
      recommendationContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_scores (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       score_model_version, rule_version, total_score, components, weights,
       evidence, generated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       'recommendation-commercial-fit.v3', 'legacy-rules-v3', 71,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), 'phase-2-integration'
     )`,
    [
      id(22),
      organizationId,
      workspaceId,
      websiteProjectId,
      legacyRecommendationId,
      id(20),
      recommendationContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_inventory (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       visible_pool_generation, status, publication_status,
       verified_public_email_count, fit_decision, contact_decision,
       contact_reason_code, fit_score_model_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 1, 'ready', 'CONTACT_REVIEW',
       0, 'eligible', 'pending', 'CONTACT_PENDING',
       'recommendation-commercial-fit.v3',
       'phase-2-integration', 'phase-2-integration'
     )`,
    [
      id(23),
      organizationId,
      workspaceId,
      websiteProjectId,
      legacyRecommendationId,
      id(20),
      recommendationContextVersionId,
    ],
  );
}

async function seedHistoricalDiscoveryLineage(
  client: RuntimeClient,
): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_jobs (
       id, organization_id, workspace_id, website_project_id, job_type,
       source_object_type, source_object_id, status, workflow_id,
       correlation_id, started_at, finished_at, created_by, updated_by
     ) VALUES
     (
       $1, $2, $3, $4, 'recommendation_refill',
       'recommendation_context', $5, 'success', 'lineage-job-1',
       'lineage-correlation-1', '2026-08-17T00:00:00Z',
       '2026-08-17T00:10:00Z', 'lineage-test', 'lineage-test'
     ),
     (
       $6, $2, $3, $4, 'recommendation_refill',
       'recommendation_context', $5, 'success', 'lineage-job-2',
       'lineage-correlation-2', '2026-08-17T00:04:00Z',
       '2026-08-17T00:08:00Z', 'lineage-test', 'lineage-test'
     )`,
    [
      historicalRefillJobId,
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      overlappingRefillJobId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_refills (
       id, organization_id, workspace_id, website_project_id, job_id,
       recommendation_context_version_id, visible_pool_generation,
       trigger_reason, low_watermark, high_watermark, refill_window_key,
       created_by, updated_by
     ) VALUES
     ($1, $2, $3, $4, $5, $6, 1, 'inventory_low', 9, 10,
      'lineage-window-1', 'lineage-test', 'lineage-test'),
     ($7, $2, $3, $4, $8, $6, 1, 'inventory_low', 9, 10,
      'lineage-window-2', 'lineage-test', 'lineage-test')`,
    [
      id(46),
      organizationId,
      workspaceId,
      websiteProjectId,
      historicalRefillJobId,
      recommendationContextVersionId,
      id(47),
      overlappingRefillJobId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id, organization_id, workspace_id, website_project_id,
       project_context_version_id, blueprint_version, generator,
       schema_version, prompt_version, rule_version, blueprint,
       evidence_refs, generated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 1, 'DETERMINISTIC_FALLBACK',
       'lineage-test.v1', 'lineage-test.v1', 'lineage-test.v1',
       '{}'::jsonb, '[]'::jsonb, '2026-08-17T00:00:00Z',
       'lineage-test'
     )`,
    [
      historicalBlueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_batches (
       id, organization_id, workspace_id, website_project_id, blueprint_id,
       project_context_version_id, status, idempotency_key, request_intent,
       source_types, started_at, finished_at, created_by,
       visible_pool_generation
     ) VALUES
     (
       $1, $2, $3, $4, $5, $6, 'completed', 'lineage-batch-unique',
       'DISCOVERY', '["EXISTING_HISTORY"]'::jsonb,
       '2026-08-17T00:02:00Z', '2026-08-17T00:03:00Z',
       'lineage-test', 1
     ),
     (
       $7, $2, $3, $4, $5, $6, 'completed', 'lineage-batch-ambiguous',
       'DISCOVERY', '["EXISTING_HISTORY"]'::jsonb,
       '2026-08-17T00:05:00Z', '2026-08-17T00:06:00Z',
       'lineage-test', 1
     )`,
    [
      uniqueHistoricalBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      historicalBlueprintId,
      recommendationContextVersionId,
      ambiguousHistoricalBatchId,
    ],
  );
}

const fitScore = (
  total: number,
  scoreModelVersion:
    | "recommendation-commercial-fit.v3"
    | "recommendation-commercial-fit.v4",
  ruleVersion: string,
) => JSON.stringify({
  decision: "eligible",
  total,
  scoreModelVersion,
  ruleVersion,
  details: {
    matchTier: total >= 75 ? "high_fit" : "qualified_fit",
    reasonCodes: ["QUALIFIED"],
    market: {
      targetCountry: "US",
      candidateCountry: "US",
      targetLanguage: "en",
      candidateLanguage: "en",
      tier: "target_market",
      reasonCode: "TARGET_MARKET",
    },
  },
  components: [],
});

async function seedLegacyVisibleFallback(
  client: RuntimeClient,
): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id, organization_id, workspace_id, website_project_id,
       snapshot_version, project_status, canonical_domain, locale,
       country_code, profile_version_id, promotion_target_version_id,
       products, keywords, target_urls, target_market, target_audiences,
       partnership_goals, created_by
     ) VALUES (
       $1, $2, $3, $4, 2, 'ACTIVE', 'owner.test', 'en-US', 'US',
       'fallback-profile-v1', 'fallback-promotion-v1',
       '["seo audit"]'::jsonb, '["technical seo"]'::jsonb, '[]'::jsonb,
       'US', '["site owners"]'::jsonb, '["editorial mention"]'::jsonb,
       'legacy-fallback-test'
     )`,
    [
      fallbackContextVersionId,
      organizationId,
      workspaceId,
      websiteProjectId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id, organization_id, workspace_id, website_project_id,
       profile_version_id, promotion_target_version_id,
       keywords_and_topics, products_and_services, target_urls,
       target_audiences, partnership_goals, market, location, language,
       authorized_discovery_sources, immutable_fingerprint, created_by
     ) VALUES (
       $1, $2, $3, $4, 'fallback-profile-v1', 'fallback-promotion-v1',
       '["technical seo"]'::jsonb, '["seo audit"]'::jsonb,
       '[]'::jsonb, '["site owners"]'::jsonb,
       '["editorial mention"]'::jsonb, 'US', 'United States', 'en',
       '["shared-seo-evidence"]'::jsonb, 'fallback-profile-fingerprint',
       'legacy-fallback-test'
     )`,
    [id(116), organizationId, workspaceId, websiteProjectId],
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
       $1, $2, $3, $4, 2, 'fallback-site-profile-v1', $5,
       'fallback-promotion-v1', '[]'::jsonb, '[]'::jsonb, 'US',
       $6, 'fallback-input-pin-fingerprint', 'legacy-fallback-test'
     )`,
    [
      fallbackInputPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      id(116),
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id, organization_id, workspace_id, website_project_id,
       project_context_version_id, blueprint_version, generator,
       schema_version, prompt_version, rule_version, blueprint,
       evidence_refs, generated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 1, 'DETERMINISTIC_FALLBACK',
       'legacy-fallback.v1', 'legacy-fallback.v1', 'legacy-fallback.v1',
       '{}'::jsonb, '[]'::jsonb, now(), 'legacy-fallback-test'
     )`,
    [
      fallbackBlueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_batches (
       id, organization_id, workspace_id, website_project_id, blueprint_id,
       project_context_version_id, status, idempotency_key, request_intent,
       source_types, started_at, finished_at, created_by,
       visible_pool_generation, raw_candidate_count
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'completed',
       'legacy-fallback-batch', 'DISCOVERY', '["EXISTING_HISTORY"]'::jsonb,
       now() - interval '1 minute', now(), 'legacy-fallback-test', 1, 2
     )`,
    [
      fallbackBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackBlueprintId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_inventory_policies (
       organization_id, workspace_id, website_project_id,
       project_context_version_id, visible_pool_generation,
       visible_pool_state, updated_by
     ) VALUES ($1, $2, $3, $4, 1, 'building', 'legacy-fallback-test')`,
    [
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_prospects (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, hostname_ascii,
       registrable_domain, normalization_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'legacy-visible.test', 'legacy-visible.test',
       'tldts-v1', 'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackLegacyProspectId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendations (
       id, organization_id, workspace_id, website_project_id, prospect_id,
       recommendation_context_version_id, status, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'ready',
       'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackLegacyRecommendationId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_scores (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       score_model_version, rule_version, total_score, components, weights,
       evidence, generated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       'recommendation-commercial-fit.v3', 'legacy-rules-v3', 71,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now(),
       'legacy-fallback-test'
     )`,
    [
      id(117),
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyRecommendationId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_inventory (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       visible_pool_generation, status, publication_status,
       verified_public_email_count, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 1, 'ready', 'CONTACT_REVIEW', 0,
       'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackLegacyInventoryId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyRecommendationId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_contact_candidates (
       id, organization_id, workspace_id, website_project_id, prospect_id,
       recommendation_context_version_id, normalized_email,
       email_domain_ascii, domain_relation, syntax_validator_version,
       confidence, guessed, status, inferred_purpose, purpose_confidence,
       created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'editor@legacy-visible.test',
       'legacy-visible.test', 'same_registrable_domain', 'email-syntax.v1',
       95, false, 'candidate', 'editorial', 95,
       'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackLegacyContactCandidateId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_contact_evidence (
       id, organization_id, workspace_id, website_project_id, candidate_id,
       source_url, observed_at, extraction_method, evidence_snippet,
       parser_version, content_sha256, confidence, expires_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'https://legacy-visible.test/contact', now(),
       'visible_text', 'editor@legacy-visible.test', 'contact-parser.v1',
       repeat('a', 64), 95, now() + interval '30 days',
       'legacy-fallback-test'
     )`,
    [
      fallbackLegacyContactEvidenceId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyContactCandidateId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_contact_evidence_snapshots (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       contact_candidate_id, contact_evidence_id, source_url, email_sha256,
       email_reference, inferred_purpose, contact_confidence,
       purpose_confidence, evidence_confidence, collected_at, rules_version,
       created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       'https://legacy-visible.test/contact', repeat('b', 64), $10,
       'editorial', 95, 95, 95, now(), 'contact-publication.v1',
       'legacy-fallback-test'
     )`,
    [
      fallbackLegacyContactSnapshotId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackLegacyRecommendationId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
      fallbackLegacyContactCandidateId,
      fallbackLegacyContactEvidenceId,
      `contact-evidence:${fallbackLegacyContactEvidenceId}`,
    ],
  );
  await client.query(
    `UPDATE backlinks.backlink_recommendation_inventory
        SET publication_status='PUBLISHED',
            fit_decision='eligible',
            fit_score_model_version='recommendation-commercial-fit.v3',
            contact_decision='eligible',
            contact_reason_code='PUBLIC_EMAIL_FOUND',
            verified_public_email_count=1,
            contact_evidence_snapshot_id=$2,
            default_contact_candidate_id=$3,
            default_contact_source_url='https://legacy-visible.test/contact',
            default_contact_email_sha256=repeat('b', 64),
            default_contact_email_reference=$4,
            contact_collected_at=now(),
            contact_rules_version='contact-publication.v1',
            updated_at=now()
      WHERE id=$1`,
    [
      fallbackLegacyInventoryId,
      fallbackLegacyContactSnapshotId,
      fallbackLegacyContactCandidateId,
      `contact-evidence:${fallbackLegacyContactEvidenceId}`,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_candidates (
       id, organization_id, workspace_id, website_project_id, blueprint_id,
       discovery_batch_id, recommendation_id, prospect_id,
       project_context_version_id, canonical_domain, source_types,
       static_assessment, gate_decision, commercial_score,
       score_model_version, state, created_by, updated_by,
       visible_pool_generation
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'legacy-visible.test',
       '["EXISTING_HISTORY"]'::jsonb, '{}'::jsonb,
       '{"decision":"eligible"}'::jsonb, $10::jsonb,
       'recommendation-commercial-fit.v3', 'published',
       'legacy-fallback-test', 'legacy-fallback-test', 1
     )`,
    [
      fallbackLegacyCommercialCandidateId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackBlueprintId,
      fallbackBatchId,
      fallbackLegacyRecommendationId,
      fallbackLegacyProspectId,
      fallbackContextVersionId,
      fitScore(
        71,
        "recommendation-commercial-fit.v3",
        "legacy-rules-v3",
      ),
    ],
  );
}

async function seedInvalidV4Publication(client: RuntimeClient): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_prospects (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, hostname_ascii,
       registrable_domain, normalization_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'current-visible.test', 'current-visible.test',
       'tldts-v1', 'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackV4ProspectId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendations (
       id, organization_id, workspace_id, website_project_id, prospect_id,
       recommendation_context_version_id, status, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'ready',
       'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackV4RecommendationId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackV4ProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_inventory (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       visible_pool_generation, status, publication_status,
       verified_public_email_count, fit_decision, contact_decision,
       contact_reason_code, fit_score_model_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 1, 'ready', 'PUBLISHED', 0,
       'eligible', 'pending', 'CONTACT_PENDING',
       'recommendation-commercial-fit.v4',
       'legacy-fallback-test', 'legacy-fallback-test'
     )`,
    [
      fallbackV4InventoryId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackV4RecommendationId,
      fallbackV4ProspectId,
      fallbackContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_candidates (
       id, organization_id, workspace_id, website_project_id, blueprint_id,
       discovery_batch_id, recommendation_id, prospect_id,
       project_context_version_id, canonical_domain, source_types,
       static_assessment, gate_decision, commercial_score,
       score_model_version, state, created_by, updated_by,
       visible_pool_generation
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'current-visible.test',
       '["EXISTING_HISTORY"]'::jsonb, '{}'::jsonb,
       '{"decision":"eligible"}'::jsonb, $10::jsonb,
       'recommendation-commercial-fit.v4', 'published',
       'legacy-fallback-test', 'legacy-fallback-test', 1
     )`,
    [
      fallbackV4CommercialCandidateId,
      organizationId,
      workspaceId,
      websiteProjectId,
      fallbackBlueprintId,
      fallbackBatchId,
      fallbackV4RecommendationId,
      fallbackV4ProspectId,
      fallbackContextVersionId,
      fitScore(
        82,
        "recommendation-commercial-fit.v4",
        commercialQualificationRuleVersion,
      ),
    ],
  );
}

const visibleCountSql = `
  SELECT count(*)::integer AS count
    FROM backlinks.backlink_recommendation_inventory
   WHERE organization_id = $1
     AND workspace_id = $2
     AND website_project_id = $3
     AND recommendation_context_version_id = $4
     AND publication_status = 'PUBLISHED'
     AND fit_decision = 'eligible'
     AND fit_score_model_version = 'recommendation-commercial-fit.v3'
     AND contact_decision = 'eligible'
     AND contact_reason_code = 'PUBLIC_EMAIL_FOUND'
     AND verified_public_email_count >= 1
     AND status IN ('ready', 'shown', 'accepted')
`;

describe("Phase 2 recommendation contract compatibility", () => {
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let pool: RuntimePool;
  let names: string[];
  let visibleCountBefore = -1;
  let ownedLineageAfter0066 = -1;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await admin.query(await readFile(rolesUrl, "utf8"));
    await admin.query(platformProjectFunction);
    names = await migrationNames();
    await applyMigrations(
      admin,
      names.filter(
        (name) => !name.startsWith("0001_") && name <= "0061_zzzz",
      ),
    );
    await seedProjectInputsAndLegacyV3(admin);
    const before = await admin.query(visibleCountSql, [
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
    ]);
    visibleCountBefore = Number(before.rows[0]?.count);
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0062_" && name <= "0065_zzzz"),
    );
    await seedHistoricalDiscoveryLineage(admin);
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0066_" && name <= "0066_zzzz"),
    );
    const after0066 = await admin.query(
      `SELECT count(refill_job_id)::integer AS count
         FROM backlinks.backlink_commercial_discovery_batches
        WHERE id IN ($1, $2)`,
      [uniqueHistoricalBatchId, ambiguousHistoricalBatchId],
    );
    ownedLineageAfter0066 = Number(after0066.rows[0]?.count);
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0067_" && name <= "0067_zzzz"),
    );
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0068_" && name <= "0070_zzzz"),
    );
    await seedLegacyVisibleFallback(admin);
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0071_" && name <= "0071_zzzz"),
    );
    await admin.query("SET search_path = backlinks, pg_catalog");
    pool = new PgPool({ connectionString: harness.connectionString });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
    await harness?.stop();
  });

  it("repairs only uniquely provable historical refill lineage", async () => {
    expect(ownedLineageAfter0066).toBe(0);
    const lineage = await admin.query(
      `SELECT id, refill_job_id AS "refillJobId"
         FROM backlinks.backlink_commercial_discovery_batches
        WHERE id IN ($1, $2)
        ORDER BY id`,
      [uniqueHistoricalBatchId, ambiguousHistoricalBatchId],
    );
    expect(lineage.rows).toEqual([
      {
        id: uniqueHistoricalBatchId,
        refillJobId: historicalRefillJobId,
      },
      {
        id: ambiguousHistoricalBatchId,
        refillJobId: null,
      },
    ]);
  });

  it("reads the exact immutable input pin through the tenant projection", async () => {
    const repository = createProjectInputPersistenceRepository(pool);

    await expect(repository.readGenerationInputBinding({
      organizationId,
      workspaceId,
      websiteProjectId,
      inputPinId,
      qualificationContractVersion:
        CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      market: "US",
    })).resolves.toMatchObject({
      inputPinId,
      pins: {
        projectContextVersion: 1,
        siteProfileVersionId: "site-profile-v1",
        outreachProfileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
        sharedEvidenceSnapshotIds: [],
        qualificationContractVersion:
          CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      },
      outreachProfile: {
        profileVersionId: "profile-v1",
        market: "US",
        location: "United States",
        language: "en",
      },
      sharedEvidence: [],
    });
  });

  it("upgrades 0061 data, preserves V3 reads, and round-trips corrected facts", async () => {
    const repository = createRecommendationContractRepository(pool);
    await expect(repository.readRecommendation({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      recommendationId: legacyRecommendationId,
    })).resolves.toMatchObject({
      contractKind: "legacy-v3",
      canonicalDomain: "legacy.test",
      totalScore: 71,
    });

    await repository.createCorrectedGeneration({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      generationContractId,
      inputPinId,
      visiblePoolGeneration: 2,
      metricScope: "TARGET_MARKET",
      market: "US",
      location: "United States",
      language: "en",
      trafficLocationCode: 2840,
      trafficLanguageCode: "en",
      requestFingerprints: { traffic: "traffic-request-2" },
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      operation: {
        factId: id(12),
        operationId: "generation-2",
        state: "requested",
        attempt: 1,
        reasonCode: "USER_REFRESH",
        evidence: {},
        observedAt: new Date("2026-08-15T08:00:00.000Z"),
      },
      createdBy: "phase-2-integration",
    });
    await repository.writeCorrectedRecommendation({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      generationContractId,
      visiblePoolGeneration: 2,
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      prospectId: id(30),
      recommendationId: correctedRecommendationId,
      scoreId: id(32),
      inventoryId: id(33),
      canonicalDomain: "corrected.test",
      normalizationVersion: "tldts-v1",
      totalScore: 84,
      scoreComponents: [{ name: "semantic", score: 84 }],
      scoreWeights: { semantic: 1 },
      scoreEvidence: { source: "phase-2-integration" },
      qualification: {
        factId: id(34),
        metricScope: "TARGET_MARKET",
        trafficOrganicEtv: 45_000,
        spamScore: 4,
        authorityRank: 62,
        accessibilityDecision: "accessible",
        semanticScore: 82,
        attempt: 1,
        decision: "eligible",
        decisionReasonCode: "QUALIFIED",
        modelVersion: "semantic-model-v1",
        promptVersion: "semantic-prompt-v1",
        ruleVersion: commercialQualificationRuleVersion,
        requestFingerprints: { traffic: "traffic-request-2" },
        evidence: {
          source: "phase-2-integration",
          freshMetricsRole: "qualification_authority",
        },
      },
      visibility: {
        factId: id(35),
        decision: "visible",
        decisionReasonCode: "QUALIFIED_VISIBLE",
        attempt: 1,
        ruleVersion: "visibility-rules-v1",
        evidence: {},
      },
      contact: {
        factId: id(36),
        decision: "pending",
        decisionReasonCode: "CONTACT_NOT_EVALUATED",
        attempt: 1,
        evidence: {},
      },
      cooperationPath: {
        factId: id(37),
        decision: "pending",
        decisionReasonCode: "PATH_NOT_EVALUATED",
        pathType: null,
        attempt: 1,
        evidence: {},
      },
      observedAt: new Date("2026-08-15T08:01:00.000Z"),
      createdBy: "phase-2-integration",
    });

    await expect(repository.readRecommendation({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      recommendationId: correctedRecommendationId,
    })).resolves.toMatchObject({
      contractKind: "corrected-v1",
      canonicalDomain: "corrected.test",
      totalScore: 84,
      qualificationDecision: "eligible",
      visibilityDecision: "visible",
      contactDecision: "pending",
      cooperationPathDecision: "pending",
    });

    const compatibilityProjection = await admin.query(
      `SELECT publication_status AS "publicationStatus",
              fit_decision AS "fitDecision",
              contact_decision AS "contactDecision"
         FROM backlinks.backlink_recommendation_inventory
        WHERE id = $1`,
      [id(33)],
    );
    expect(compatibilityProjection.rows[0]).toEqual({
      publicationStatus: "CONTACT_REVIEW",
      fitDecision: "unassessed",
      contactDecision: "pending",
    });
    const after = await admin.query(visibleCountSql, [
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
    ]);
    expect(Number(after.rows[0]?.count)).toBe(visibleCountBefore);

    const retainedDependencies = await admin.query(
      `SELECT record_type AS "recordType"
         FROM backlinks.backlink_list_project_retained_dependencies($1, $2, $3)`,
      [organizationId, workspaceId, websiteProjectId],
    );
    expect(retainedDependencies.rows).toContainEqual({
      recordType: "recommendation_generation_contract",
    });
  });

  it("rejects delayed old-Worker writes at repository and database boundaries", async () => {
    const repository = createRecommendationContractRepository(pool);
    await expect(repository.createCorrectedGeneration({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId,
      generationContractId: id(40),
      inputPinId,
      visiblePoolGeneration: 3,
      metricScope: "TARGET_MARKET",
      market: "US",
      location: "United States",
      language: "en",
      trafficLocationCode: 2840,
      trafficLanguageCode: "en",
      requestFingerprints: {},
      workerContractVersion: "recommendation-qualification.v0",
      operation: {
        factId: id(41),
        operationId: "generation-3",
        state: "requested",
        attempt: 1,
        reasonCode: "DELAYED_WORKER",
        evidence: {},
        observedAt: new Date("2026-08-15T08:02:00.000Z"),
      },
      createdBy: "phase-2-integration",
    })).rejects.toThrow(/does not match/u);

    await expect(withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (client) => client.query(
        `INSERT INTO backlinks.backlink_generation_operation_facts (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           operation_id, operation_state, attempt, reason_code,
           fact_contract_version, worker_contract_version, evidence,
           observed_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'delayed-worker', 'running', 1,
           'DELAYED_WORKER', $7, 'recommendation-qualification.v0',
           '{}'::jsonb, now(), 'phase-2-integration'
         )`,
        [
          id(42),
          organizationId,
          workspaceId,
          websiteProjectId,
          generationContractId,
          recommendationContextVersionId,
          CORRECTED_QUALIFICATION_CONTRACT_VERSION,
        ],
      ),
    )).rejects.toThrow(/Worker contract version does not match/u);
  });

  it("reapplies the V4 publication contract with one legacy guard", async () => {
    await applyMigrations(
      admin,
      names.filter((name) => name >= "0071_" && name <= "0071_zzzz"),
    );

    const trigger = await admin.query(
      `SELECT count(*)::integer AS count
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'backlinks'
          AND c.relname = 'backlink_recommendation_inventory'
          AND t.tgname = 'backlink_rec_inventory_legacy_v3_publication_guard'
          AND NOT t.tgisinternal`,
    );

    expect(trigger.rows[0]?.count).toBe(1);
  });

  it("keeps V3 visible until a valid V4 contract takes over", async () => {
    const query = createRecommendationsQuery(admin);
    const context = {
      actor: createActorContext({
        userId: "legacy-fallback-test",
        sessionId: "legacy-fallback-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "fallback-profile-v1",
        promotionTargetVersionId: "fallback-promotion-v1",
      }),
    };

    await expect(query.listRecommendations(context, { limit: 25 })).resolves
      .toMatchObject({
        presentationState: "legacy_stale",
        items: [{
          id: fallbackLegacyRecommendationId,
          hostname: "legacy-visible.test",
          presentationState: "legacy_stale",
          scoreModelVersion: "recommendation-commercial-fit.v3",
          canCreateOpportunity: false,
        }],
      });

    await expect(admin.query(
      `UPDATE backlinks.backlink_recommendation_inventory
          SET updated_by='legacy-mutation'
        WHERE id=$1`,
      [fallbackLegacyInventoryId],
    )).rejects.toThrow(/Legacy V3 recommendation publications are read-only/u);

    await seedInvalidV4Publication(admin);
    await expect(query.listRecommendations(context, { limit: 25 })).resolves
      .toMatchObject({
        presentationState: "legacy_stale",
        items: [{
          id: fallbackLegacyRecommendationId,
          hostname: "legacy-visible.test",
          presentationState: "legacy_stale",
        }],
      });

    const repository = createRecommendationContractRepository(pool);
    await repository.createCorrectedGeneration({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId: fallbackContextVersionId,
      generationContractId: fallbackGenerationContractId,
      inputPinId: fallbackInputPinId,
      visiblePoolGeneration: 1,
      metricScope: "TARGET_MARKET",
      market: "US",
      location: "United States",
      language: "en",
      trafficLocationCode: 2840,
      trafficLanguageCode: "en",
      requestFingerprints: {},
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      operation: {
        factId: id(118),
        operationId: "fallback-generation-1",
        state: "succeeded",
        attempt: 1,
        reasonCode: "V4_RECALCULATION",
        evidence: {},
        observedAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      createdBy: "legacy-fallback-test",
    });
    await repository.writeCorrectedRecommendation({
      organizationId,
      workspaceId,
      websiteProjectId,
      recommendationContextVersionId: fallbackContextVersionId,
      generationContractId: fallbackGenerationContractId,
      visiblePoolGeneration: 1,
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      prospectId: fallbackV4ProspectId,
      recommendationId: fallbackV4RecommendationId,
      scoreId: id(119),
      inventoryId: fallbackV4InventoryId,
      canonicalDomain: "current-visible.test",
      normalizationVersion: "tldts-v1",
      totalScore: 82,
      scoreComponents: [],
      scoreWeights: {},
      scoreEvidence: {},
      qualification: {
        factId: id(120),
        metricScope: "TARGET_MARKET",
        trafficOrganicEtv: 40_000,
        spamScore: 5,
        authorityRank: 60,
        accessibilityDecision: "accessible",
        semanticScore: 82,
        attempt: 1,
        decision: "eligible",
        decisionReasonCode: "QUALIFIED",
        modelVersion: "semantic-model-v1",
        promptVersion: "semantic-prompt-v1",
        ruleVersion: commercialQualificationRuleVersion,
        requestFingerprints: {},
        evidence: {},
      },
      visibility: {
        factId: id(121),
        decision: "visible",
        decisionReasonCode: "QUALIFIED_VISIBLE",
        attempt: 1,
        ruleVersion: "visibility-rules-v1",
        evidence: {},
      },
      contact: {
        factId: id(122),
        decision: "pending",
        decisionReasonCode: "CONTACT_NOT_EVALUATED",
        attempt: 1,
        evidence: {},
      },
      cooperationPath: {
        factId: id(123),
        decision: "pending",
        decisionReasonCode: "PATH_NOT_EVALUATED",
        pathType: null,
        attempt: 1,
        evidence: {},
      },
      observedAt: new Date("2026-08-20T00:01:00.000Z"),
      createdBy: "legacy-fallback-test",
    });

    await expect(query.listRecommendations(context, { limit: 25 })).resolves
      .toMatchObject({
        presentationState: "current",
        items: [{
          id: fallbackV4RecommendationId,
          hostname: "current-visible.test",
          presentationState: "current",
          scoreModelVersion: "recommendation-commercial-fit.v4",
          canCreateOpportunity: true,
        }],
      });
    const legacy = await admin.query(
      `SELECT publication_status AS "publicationStatus",
              fit_score_model_version AS "scoreModelVersion"
         FROM backlinks.backlink_recommendation_inventory
        WHERE id=$1`,
      [fallbackLegacyInventoryId],
    );
    expect(legacy.rows).toEqual([{
      publicationStatus: "PUBLISHED",
      scoreModelVersion: "recommendation-commercial-fit.v3",
    }]);

    await admin.query(
      `UPDATE backlinks.backlink_commercial_candidates
          SET state='excluded',
              commercial_score=jsonb_set(
                commercial_score,
                '{decision}',
                '"ineligible"'::jsonb
              ),
              updated_by='legacy-fallback-test'
        WHERE id=$1`,
      [fallbackV4CommercialCandidateId],
    );
    await admin.query(
      `UPDATE backlinks.backlink_recommendation_inventory
          SET publication_status='NOT_PUBLISHED',
              fit_decision='ineligible',
              updated_by='legacy-fallback-test'
        WHERE id=$1`,
      [fallbackV4InventoryId],
    );

    const afterWithdrawal = await query.listRecommendations(context, {
      limit: 25,
    });
    const inventory = await query.getRecommendationInventoryStatus(
      context,
      "test-build",
    );
    expect(
      afterWithdrawal.items.filter(
        (item) =>
          item.scoreModelVersion === "recommendation-commercial-fit.v4",
      ),
    ).toEqual([]);
    expect(inventory.visibleMatchCount).toBe(0);
    expect(inventory.publishedCount).toBe(0);
  });

  it("supports a clean PostgreSQL 18 install through 0066", async () => {
    const cleanDatabase = "backlinks_clean_install";
    await admin.query(`CREATE DATABASE ${cleanDatabase}`);
    const cleanUrl = new URL(harness.connectionString);
    cleanUrl.pathname = `/${cleanDatabase}`;
    const clean = new PgClient({ connectionString: cleanUrl.toString() });
    await clean.connect();
    try {
      await clean.query(await readFile(migrationUrl(names[0] ?? ""), "utf8"));
      await clean.query(await readFile(rolesUrl, "utf8"));
      await clean.query(platformProjectFunction);
      await applyMigrations(clean, names.slice(1));
      const result = await clean.query(
        `SELECT to_regclass(
           'backlinks.backlink_recommendation_generation_contracts'
         )::text AS generation,
         to_regclass(
           'backlinks.backlink_recommendation_cooperation_path_facts'
         )::text AS cooperation`,
      );
      expect(result.rows[0]).toEqual({
        generation: "backlinks.backlink_recommendation_generation_contracts",
        cooperation:
          "backlinks.backlink_recommendation_cooperation_path_facts",
      });
    } finally {
      await clean.end();
    }
  }, 120_000);
});
