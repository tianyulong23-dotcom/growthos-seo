import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOpportunitiesQuery } from "../../../src/modules/backlinks/application/queries/opportunities.query.js";
import { createDraftGenerationRepository } from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { applyBacklinksDeploymentManifest } from "../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";
import { createOpportunityRepository } from "../../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import { createRecommendationUserReleaseRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type PoolClient = {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
};
type Pool = {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};
const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => Pool;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `019a0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const otherOrganizationId = id(4);
const otherWorkspaceId = id(5);
const otherProjectId = id(6);
const outreachProfileId = id(10);
const inputPinId = id(11);
const generationId = id(12);
const recommendationContextVersionId = id(13);
const blueprintId = id(14);
const discoveryBatchId = id(15);
const releaseBatchId = id(16);
const actorAPublicationId = id(17);
const actorBPublicationId = id(18);
const projectContractId = id(19);
const secondReleaseBatchId = id(20);
const actorA = "recommendation-actor-a";
const actorB = "recommendation-actor-b";
const actorC = "recommendation-actor-c";
const actorWithoutPublication = "recommendation-actor-hidden";
const draftRequest = {
  cooperationType: "GENERAL_PARTNERSHIP",
  linkAttributePreference: "NOT_SPECIFIED",
  promotionTargetUrl: "https://owner.test/resources",
  anchorTextSuggestion: null,
  language: "en-US",
  tone: "NEUTRAL_BUSINESS",
  subjectStyle: "CLEAR_DIRECT",
  additionalRequirements: "",
  forbiddenPhrases: [],
} as const;

type SeededItem = Readonly<{
  itemId: string;
  prospectId: string;
  recommendationId: string;
  inventoryId: string;
  commercialCandidateId: string;
  generationCandidateId: string;
  contactCandidateId: string | null;
  contactEvidenceId: string | null;
  contactSnapshotId: string | null;
  domain: string;
  releaseEmail: string | null;
}>;

function metricSnapshot(metric: string): string {
  return JSON.stringify({
    value: null,
    provider: "fixture",
    endpoint: `fixture/${metric}`,
    market: "US",
    location: "United States",
    language: "en",
    observedAt: "2026-08-28T00:00:00.000Z",
    artifactRef: `opportunity-feed-fixture:${metric}`,
  });
}

function commandInput(
  sequence: number,
  actorId: string,
  recommendationFeedItemId: string,
  overrides: Partial<
    Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      idempotencyKey: string;
      requestHash: string;
    }>
  > = {},
) {
  return {
    organizationId: overrides.organizationId ?? organizationId,
    workspaceId: overrides.workspaceId ?? workspaceId,
    websiteProjectId: overrides.websiteProjectId ?? websiteProjectId,
    actorId,
    recommendationFeedItemId,
    idempotencyKey: overrides.idempotencyKey ?? `feed-opportunity-${sequence}`,
    requestHash: overrides.requestHash ?? `feed-request-hash-${sequence}`,
    requestId: `feed-request-${sequence}`,
    idempotencyRecordId: id(1000 + sequence * 10),
    opportunityId: id(1001 + sequence * 10),
    cycleId: id(1002 + sequence * 10),
    lifecycleEventId: id(1003 + sequence * 10),
    auditEventId: id(1004 + sequence * 10),
    contactId: id(1005 + sequence * 10),
    opportunityCreatedActionId: id(1006 + sequence * 10),
  };
}

describe("V2 released item canonical Opportunity bridge", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: Pool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(rolesUrl, "utf8"));
    await client.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;
      CREATE TABLE projects (id text PRIMARY KEY);
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
    `);

    await applyBacklinksDeploymentManifest({
      query: (sql) => client.query(sql),
      startRevision: "0001",
      targetRevision: "0093",
    });
    await client.query("SET search_path = backlinks, pg_catalog");
    pool = new PgPool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,pg_catalog",
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("creates canonical Opportunities atomically and counts only actor inserts", async () => {
    await client.query(
      `INSERT INTO backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, 'profile-v2', 'promotion-target-v2',
         '["technical seo"]'::jsonb, '["seo platform"]'::jsonb,
         '["https://owner.test/resources"]'::jsonb,
         '["publishers"]'::jsonb, '["editorial coverage"]'::jsonb,
         'US', 'United States', 'en',
         '["shared-seo-evidence"]'::jsonb,
         'feed-opportunity-outreach-v2', 'fixture'
       )`,
      [outreachProfileId, organizationId, workspaceId, websiteProjectId],
    );
    await client.query(
      `INSERT INTO backlink_generation_input_pins (
         id, organization_id, workspace_id, website_project_id,
         project_context_version, site_profile_version_id,
         outreach_profile_version_id, promotion_target_version_id,
         keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
         market, qualification_contract_version, immutable_fingerprint,
         created_by
       ) VALUES (
         $1, $2, $3, $4, 8, 'site-profile-v2', $5,
         'promotion-target-v2', '[]'::jsonb, '[]'::jsonb, 'US',
          'recommendation-pool-admission.v2', 'feed-opportunity-input-v2',
         'fixture'
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        websiteProjectId,
        outreachProfileId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_project_context_snapshots (
         id, organization_id, workspace_id, website_project_id,
         snapshot_version, project_status, canonical_domain, locale,
         country_code, profile_version_id, promotion_target_version_id,
         products, keywords, target_urls, created_by
       ) VALUES (
         $1, $2, $3, $4, 8, 'ACTIVE', 'owner.test', 'en-US', 'US',
         'site-profile-v2', 'promotion-target-v2',
         '["seo platform"]'::jsonb, '["technical seo"]'::jsonb,
         '["https://owner.test/resources"]'::jsonb, 'fixture'
       )`,
      [
        recommendationContextVersionId,
        organizationId,
        workspaceId,
        websiteProjectId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_generation_contracts (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, qualification_contract_version,
         visibility_contract_version, score_model_version, metric_scope,
         market, location, language, traffic_location_code,
         traffic_language_code, request_fingerprints,
         creator_worker_contract_version, created_by,
         pool_contract_version, seed_contract_version,
         release_contract_version, recommendation_marker_version,
         discovery_budget_policy_version
       ) VALUES (
         $1, $2, $3, $4, $5, 2, $6,
          'recommendation-pool-admission.v2',
          'recommendation-pool-release-visibility.v2',
          'recommendation-pool-materialization.v2', 'TARGET_MARKET',
          'US', 'United States', 'en', 2840, 'en', '{}'::jsonb,
          'recommendation-pool-worker.v2', 'fixture',
         'recommendation-pool.v2', 'recommendation-seed.v2',
         'recommendation-release.v2', 'recommendation-marker.v2',
         'recommendation-discovery-budget.v2'
       )`,
      [
        generationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        inputPinId,
      ],
    );
    await client.query(
      `UPDATE backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=4,
              canonical_batch_size=3,
              canonical_batch_count=2,
              canonical_order_fingerprint='feed-opportunity-order-v2',
              discovery_terminal_reason='BUDGET_COMPLETE',
              discovery_completed_at=statement_timestamp()
        WHERE id=$1`,
      [generationId],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, state_reason_codes, activated_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, 'recommendation-pool.v2', 'V2_ACTIVE', $5, $6, 2,
         $7, '[]'::jsonb, statement_timestamp(), 'fixture', 'fixture'
       )`,
      [
        projectContractId,
        organizationId,
        workspaceId,
        websiteProjectId,
        generationId,
        recommendationContextVersionId,
        inputPinId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_discovery_blueprints (
         id, organization_id, workspace_id, website_project_id,
         project_context_version_id, blueprint_version, generator,
         schema_version, prompt_version, rule_version, blueprint,
         evidence_refs, generated_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 'DETERMINISTIC_FALLBACK',
         'recommendation-blueprint.v2', 'recommendation-seed.v2',
         'recommendation-discovery.v2', '{}'::jsonb, '[]'::jsonb,
         statement_timestamp(), 'fixture'
       )`,
      [
        blueprintId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_discovery_batches (
         id, organization_id, workspace_id, website_project_id, blueprint_id,
         project_context_version_id, status, idempotency_key, request_intent,
         source_types, provider_request_fingerprints, paid_cost_micros,
         started_at, finished_at, created_by, visible_pool_generation
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'completed',
         'feed-opportunity-discovery-v2', 'DISCOVERY',
         '["EXISTING_HISTORY"]'::jsonb, '[]'::jsonb, 0,
         statement_timestamp(), statement_timestamp(), 'fixture', 2
       )`,
      [
        discoveryBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        recommendationContextVersionId,
      ],
    );

    const seedItem = async (
      sequence: number,
      domain: string,
      releaseEmail: string | null,
      canonicalEmail: string | null,
      targetBatchId = releaseBatchId,
      batchPosition = sequence,
    ): Promise<SeededItem> => {
      const item = {
        itemId: id(100 + sequence * 10),
        prospectId: id(101 + sequence * 10),
        recommendationId: id(102 + sequence * 10),
        inventoryId: id(103 + sequence * 10),
        commercialCandidateId: id(104 + sequence * 10),
        generationCandidateId: id(108 + sequence * 10),
        contactCandidateId:
          canonicalEmail === null ? null : id(105 + sequence * 10),
        contactEvidenceId:
          canonicalEmail === null ? null : id(106 + sequence * 10),
        contactSnapshotId:
          canonicalEmail === null ? null : id(107 + sequence * 10),
        domain,
        releaseEmail,
      } satisfies SeededItem;
      const hostname = `www.${domain}`;
      const contactPageUrl = `https://${hostname}/contact`;

      await client.query(
        `INSERT INTO backlink_prospects (
           id, organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, hostname_ascii,
           registrable_domain, normalization_version, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'tldts-v1', 'fixture', 'fixture'
         )`,
        [
          item.prospectId,
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId,
          hostname,
          domain,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendations (
            id, organization_id, workspace_id, website_project_id, prospect_id,
            recommendation_context_version_id, status, created_by, updated_by,
            generation_contract_id, visible_pool_generation, input_pin_id,
            pool_contract_version, materialization_contract_version
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'shown', 'fixture', 'fixture',
            $7, 2, $8, 'recommendation-pool.v2',
            'recommendation-pool-materialization.v2'
          )`,
        [
          item.recommendationId,
          organizationId,
          workspaceId,
          websiteProjectId,
          item.prospectId,
          recommendationContextVersionId,
          generationId,
          inputPinId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_inventory (
           id, organization_id, workspace_id, website_project_id,
           recommendation_id, prospect_id,
           recommendation_context_version_id, visible_pool_generation,
           status, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 2, 'shown', 'fixture', 'fixture'
         )`,
        [
          item.inventoryId,
          organizationId,
          workspaceId,
          websiteProjectId,
          item.recommendationId,
          item.prospectId,
          recommendationContextVersionId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_commercial_candidates (
           id, organization_id, workspace_id, website_project_id, blueprint_id,
           discovery_batch_id, recommendation_id, prospect_id,
           project_context_version_id, canonical_domain, source_types,
           static_assessment, gate_decision, commercial_score,
           score_model_version, state, provider_collected_at,
           created_by, updated_by, visible_pool_generation
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           '["EXISTING_HISTORY"]'::jsonb, '{}'::jsonb,
           '{"decision":"eligible","hitGates":[],"missingEvidence":[]}'::jsonb,
           '{
             "decision":"eligible",
             "total":72,
             "scoreModelVersion":"recommendation-commercial-fit.v4",
             "ruleVersion":"recommendation-commercial-fit-rules.v4.2",
             "admission":{"appliedThreshold":50}
           }'::jsonb,
           'recommendation-commercial-fit.v4', 'candidate_ready',
           statement_timestamp(), 'fixture', 'fixture', 2
         )`,
        [
          item.commercialCandidateId,
          organizationId,
          workspaceId,
          websiteProjectId,
          blueprintId,
          discoveryBatchId,
          item.recommendationId,
          item.prospectId,
          recommendationContextVersionId,
          domain,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_generation_candidates (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, pool_contract_version,
           canonical_domain, admission_state, admission_contract_version,
           exclusion_evidence, decision_evidence, first_seen_request_intent,
           recommended, recommendation_reason_codes, first_seen_at, admitted_at,
           decided_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, 'recommendation-pool.v2',
           $8, 'ADMITTED', 'recommendation-pool-admission.v2', '{}'::jsonb,
           '{"contractVersion":"recommendation-pool-admission.v2","passedRequiredExclusions":true}'::jsonb,
           'EXISTING_HISTORY', true, '["COMMERCIAL_FIT"]'::jsonb,
           statement_timestamp(), statement_timestamp(), statement_timestamp(),
           'fixture'
         )`,
        [
          item.generationCandidateId,
          organizationId,
          workspaceId,
          websiteProjectId,
          generationId,
          recommendationContextVersionId,
          inputPinId,
          domain,
        ],
      );

      if (
        canonicalEmail !== null &&
        item.contactCandidateId !== null &&
        item.contactEvidenceId !== null &&
        item.contactSnapshotId !== null
      ) {
        await client.query(
          `INSERT INTO backlink_contact_candidates (
             id, organization_id, workspace_id, website_project_id,
             prospect_id, recommendation_context_version_id,
             normalized_email, email_domain_ascii, domain_relation,
             syntax_validator_version, confidence, guessed, status,
             inferred_purpose, purpose_confidence, created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, split_part($7,'@',2),
             'same_registrable_domain', 'email-syntax.v1', 95, false,
             'candidate', 'editorial', 95, 'fixture', 'fixture'
           )`,
          [
            item.contactCandidateId,
            organizationId,
            workspaceId,
            websiteProjectId,
            item.prospectId,
            recommendationContextVersionId,
            canonicalEmail,
          ],
        );
        await client.query(
          `INSERT INTO backlink_contact_evidence (
             id, organization_id, workspace_id, website_project_id,
             candidate_id, source_url, observed_at, extraction_method,
             evidence_snippet, parser_version, content_sha256, confidence,
             expires_at, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, statement_timestamp(),
             'visible_text', $7, 'contact-parser.v1', repeat('b',64), 95,
             statement_timestamp()+interval '30 days', 'fixture'
           )`,
          [
            item.contactEvidenceId,
            organizationId,
            workspaceId,
            websiteProjectId,
            item.contactCandidateId,
            contactPageUrl,
            canonicalEmail,
          ],
        );
        await client.query(
          `INSERT INTO backlink_contact_evidence_snapshots (
             id, organization_id, workspace_id, website_project_id,
             recommendation_id, prospect_id,
             recommendation_context_version_id, contact_candidate_id,
             contact_evidence_id, source_url, email_sha256, email_reference,
             inferred_purpose, contact_confidence, purpose_confidence,
             evidence_confidence, collected_at, rules_version, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             repeat('c',64), $11, 'editorial', 95, 95, 95,
             statement_timestamp(), 'contact-publication.v1', 'fixture'
           )`,
          [
            item.contactSnapshotId,
            organizationId,
            workspaceId,
            websiteProjectId,
            item.recommendationId,
            item.prospectId,
            recommendationContextVersionId,
            item.contactCandidateId,
            item.contactEvidenceId,
            contactPageUrl,
            `contact-evidence:${item.contactEvidenceId}`,
          ],
        );
        await client.query(
          `UPDATE backlink_recommendation_inventory
              SET publication_status='PUBLISHED',
                  fit_decision='eligible',
                  fit_score_model_version='recommendation-commercial-fit.v4',
                  contact_decision='eligible',
                  contact_reason_code='PUBLIC_EMAIL_FOUND',
                  verified_public_email_count=1,
                  contact_evidence_snapshot_id=$2,
                  default_contact_candidate_id=$3,
                  default_contact_source_url=$4,
                  default_contact_email_sha256=repeat('c',64),
                  default_contact_email_reference=$5,
                  contact_collected_at=statement_timestamp(),
                  contact_rules_version='contact-publication.v1',
                  updated_at=statement_timestamp()
            WHERE id=$1`,
          [
            item.inventoryId,
            item.contactSnapshotId,
            item.contactCandidateId,
            contactPageUrl,
            `contact-evidence:${item.contactEvidenceId}`,
          ],
        );
      }

      await client.query(
        `INSERT INTO backlink_recommendation_release_batch_items (
           id, organization_id, workspace_id, website_project_id, batch_id,
           recommendation_context_version_id, visible_pool_generation,
           candidate_id, generation_candidate_id, recommendation_id,
           prospect_id, inventory_id, generation_contract_id, input_pin_id,
           canonical_domain, position,
           recommended, recommendation_reason_codes,
           recommendation_marker_version,
           traffic_snapshot, rank_snapshot, spam_snapshot,
           contact_terminal_reason_at_release, contact_email_at_release,
           contact_page_url_at_release, contact_completed_at_release,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, true, '["COMMERCIAL_FIT"]'::jsonb,
           'recommendation-marker.v2', $16::jsonb, $17::jsonb, $18::jsonb,
           $19, $20, $21, statement_timestamp(), 'fixture'
         )`,
        [
          item.itemId,
          organizationId,
          workspaceId,
          websiteProjectId,
          targetBatchId,
          recommendationContextVersionId,
          item.commercialCandidateId,
          item.generationCandidateId,
          item.recommendationId,
          item.prospectId,
          item.inventoryId,
          generationId,
          inputPinId,
          domain,
          batchPosition,
          metricSnapshot("traffic"),
          metricSnapshot("rank"),
          metricSnapshot("spam"),
          releaseEmail === null ? "NO_PUBLIC_CONTACT" : "PUBLIC_EMAIL_FOUND",
          releaseEmail,
          releaseEmail === null ? null : contactPageUrl,
        ],
      );
      return item;
    };

    await client.query(
      `INSERT INTO backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, batch_ordinal, state,
         original_batch_size, selection_policy_version, order_fingerprint,
         contact_total_count, preparation_started_at, deadline_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, 1, 'PREPARING', 3,
         'recommendation-release-selection.v2',
         'feed-opportunity-release-order-v2', 3,
         statement_timestamp(), statement_timestamp()+interval '18 hours',
         'fixture', 'fixture'
       )`,
      [
        releaseBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        generationId,
        recommendationContextVersionId,
        inputPinId,
      ],
    );
    const matching = await seedItem(
      1,
      "matching.test",
      "editorial@matching.test",
      "editorial@matching.test",
    );
    const missing = await seedItem(2, "missing.test", null, null);
    const mismatched = await seedItem(
      3,
      "mismatched.test",
      "release@mismatched.test",
      "canonical@mismatched.test",
    );
    await client.query(
      `UPDATE backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=3,
              available_at=statement_timestamp(),
              updated_at=statement_timestamp(),
              updated_by='fixture',
              version=2
        WHERE id=$1`,
      [releaseBatchId],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, batch_ordinal, state,
         original_batch_size, selection_policy_version, order_fingerprint,
         contact_total_count, preparation_started_at, deadline_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, 2, 'PREPARING', 1,
         'recommendation-release-selection.v2',
         'feed-opportunity-release-order-v2-next', 1,
         statement_timestamp(), statement_timestamp()+interval '18 hours',
         'fixture', 'fixture'
       )`,
      [
        secondReleaseBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        generationId,
        recommendationContextVersionId,
        inputPinId,
      ],
    );
    const nextBatchItem = await seedItem(
      4,
      "next.test",
      "editorial@next.test",
      "editorial@next.test",
      secondReleaseBatchId,
      1,
    );
    await client.query(
      `UPDATE backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=1,
              available_at=statement_timestamp(),
              updated_at=statement_timestamp(),
              updated_by='fixture',
              version=2
        WHERE id=$1`,
      [secondReleaseBatchId],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_user_publications (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, batch_id, published_by_command_id, created_by, updated_by
       ) VALUES
         ($1,$3,$4,$5,$6,2,$7,$8,'publish-actor-a','fixture','fixture'),
         ($2,$3,$4,$5,$6,2,$9,$8,'publish-actor-b','fixture','fixture')`,
      [
        actorAPublicationId,
        actorBPublicationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        actorA,
        releaseBatchId,
        actorB,
      ],
    );

    const repository = createOpportunityRepository(client);
    const createMatchingInput = commandInput(1, actorA, matching.itemId);
    const created =
      await repository.createFromRecommendationFeedItem(createMatchingInput);
    expect(created).toMatchObject({
      state: "completed",
      requestHash: createMatchingInput.requestHash,
      responseBody: {
        opportunityId: createMatchingInput.opportunityId,
        recommendationId: matching.recommendationId,
        recommendationFeedItemId: matching.itemId,
        websiteProjectId,
        targetSiteKey: matching.domain,
        targetHostAscii: `www.${matching.domain}`,
        contactCandidateId: matching.contactCandidateId,
        contactReviewRequired: false,
        existingOpportunity: false,
        teamAdded: true,
        createdByCurrentUser: true,
      },
    });
    expect(
      await repository.createFromRecommendationFeedItem(createMatchingInput),
    ).toMatchObject({
      state: "replay",
      requestHash: createMatchingInput.requestHash,
      responseBody: {
        opportunityId: createMatchingInput.opportunityId,
        createdByCurrentUser: true,
      },
    });
    const draftRepository = createDraftGenerationRepository(client);
    const draftSnapshotId = id(2001);
    const draftRequestSnapshotId = id(2002);
    expect(
      await draftRepository.prepareEvidenceSnapshot({
        organizationId,
        workspaceId,
        websiteProjectId,
        opportunityId: createMatchingInput.opportunityId,
        contactId: createMatchingInput.contactId,
        contactVersion: 1,
        snapshotId: draftSnapshotId,
        requestSnapshotId: draftRequestSnapshotId,
        request: draftRequest,
        actorId: actorA,
        recordedAt: new Date("2026-08-28T01:00:00.000Z"),
      }),
    ).toEqual({
      snapshotId: draftSnapshotId,
      requestSnapshotId: draftRequestSnapshotId,
      replayed: false,
    });
    const v2DraftEvidence = (
      await client.query(
        `SELECT evidence_items AS "evidenceItems",
                context_data AS "contextData"
           FROM backlink_evidence_snapshots
          WHERE id=$1`,
        [draftSnapshotId],
      )
    ).rows[0];
    expect(v2DraftEvidence?.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "recommendation-selection:v2",
          dataVersion:
            "recommendation-marker.v2:recommendation-release-selection.v2",
        }),
      ]),
    );
    expect(v2DraftEvidence?.contextData).toMatchObject({
      opportunity: {
        targetContext: {
          recommendationPoolV2: {
            contractVersion: "recommendation-pool.v2",
            recommendationFeedItemId: matching.itemId,
            recommendationMarkerVersion: "recommendation-marker.v2",
            selectionPolicyVersion: "recommendation-release-selection.v2",
          },
        },
      },
    });
    expect(JSON.stringify(v2DraftEvidence)).not.toContain(
      "Recommendation score",
    );

    const duplicateInput = commandInput(2, actorB, matching.itemId);
    const duplicate =
      await repository.createFromRecommendationFeedItem(duplicateInput);
    expect(duplicate).toMatchObject({
      state: "existing",
      requestHash: duplicateInput.requestHash,
      responseBody: {
        opportunityId: createMatchingInput.opportunityId,
        recommendationFeedItemId: matching.itemId,
        existingOpportunity: true,
        teamAdded: true,
        createdByCurrentUser: false,
      },
    });

    const missingInput = commandInput(3, actorA, missing.itemId);
    expect(
      await repository.createFromRecommendationFeedItem(missingInput),
    ).toMatchObject({
      state: "completed",
      responseBody: {
        opportunityId: missingInput.opportunityId,
        contactCandidateId: null,
        contactReviewRequired: true,
        existingOpportunity: false,
        createdByCurrentUser: true,
      },
    });
    await expect(
      draftRepository.prepareEvidenceSnapshot({
        organizationId,
        workspaceId,
        websiteProjectId,
        opportunityId: missingInput.opportunityId,
        contactId: missingInput.contactId,
        contactVersion: 1,
        snapshotId: id(2003),
        requestSnapshotId: id(2004),
        request: draftRequest,
        actorId: actorA,
        recordedAt: new Date("2026-08-28T01:01:00.000Z"),
      }),
    ).rejects.toThrow("Draft Contact is unavailable or version is stale.");
    expect(
      (
        await client.query(
          `SELECT
             (
               SELECT count(*)::integer
                 FROM backlink_draft_request_snapshots
                WHERE opportunity_id=$1
             ) AS "requestSnapshotCount",
             (
               SELECT count(*)::integer
                 FROM backlink_email_drafts
                WHERE opportunity_id=$1
             ) AS "draftCount",
             (
               SELECT count(*)::integer
                 FROM backlink_send_intents
                WHERE opportunity_id=$1
             ) AS "sendIntentCount"`,
          [missingInput.opportunityId],
        )
      ).rows,
    ).toEqual([
      {
        requestSnapshotCount: 0,
        draftCount: 0,
        sendIntentCount: 0,
      },
    ]);
    const mismatchedInput = commandInput(4, actorA, mismatched.itemId);
    expect(
      await repository.createFromRecommendationFeedItem(mismatchedInput),
    ).toMatchObject({
      state: "completed",
      responseBody: {
        opportunityId: mismatchedInput.opportunityId,
        contactCandidateId: null,
        contactReviewRequired: true,
        existingOpportunity: false,
        createdByCurrentUser: true,
      },
    });

    const hidden = await repository.createFromRecommendationFeedItem(
      commandInput(5, actorWithoutPublication, matching.itemId),
    );
    const wrongProject = await repository.createFromRecommendationFeedItem(
      commandInput(6, actorA, matching.itemId, {
        websiteProjectId: otherProjectId,
      }),
    );
    const wrongTenant = await repository.createFromRecommendationFeedItem(
      commandInput(7, actorA, matching.itemId, {
        organizationId: otherOrganizationId,
      }),
    );
    const wrongWorkspace = await repository.createFromRecommendationFeedItem(
      commandInput(8, actorA, matching.itemId, {
        workspaceId: otherWorkspaceId,
      }),
    );
    expect([
      hidden.state,
      wrongProject.state,
      wrongTenant.state,
      wrongWorkspace.state,
    ]).toEqual(["not_found", "not_found", "not_found", "not_found"]);

    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlink_opportunities
            WHERE website_project_id=$1`,
          [websiteProjectId],
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    expect(
      (
        await client.query(
          `SELECT target_site_key AS "targetSiteKey",
                  source_contact_candidate_id AS "contactCandidateId",
                  contact_review_required AS "contactReviewRequired"
             FROM backlink_opportunities
            WHERE website_project_id=$1
            ORDER BY target_site_key`,
          [websiteProjectId],
        )
      ).rows,
    ).toEqual([
      {
        targetSiteKey: "matching.test",
        contactCandidateId: matching.contactCandidateId,
        contactReviewRequired: false,
      },
      {
        targetSiteKey: "mismatched.test",
        contactCandidateId: null,
        contactReviewRequired: true,
      },
      {
        targetSiteKey: "missing.test",
        contactCandidateId: null,
        contactReviewRequired: true,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT normalized_email AS email,
                  source_candidate_id AS "sourceCandidateId"
             FROM backlink_contacts
            ORDER BY normalized_email`,
        )
      ).rows,
    ).toEqual([
      {
        email: "editorial@matching.test",
        sourceCandidateId: matching.contactCandidateId,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT id, status
             FROM backlink_contact_candidates
            WHERE id=ANY($1::uuid[])
            ORDER BY id`,
          [[matching.contactCandidateId, mismatched.contactCandidateId]],
        )
      ).rows,
    ).toEqual([
      { id: matching.contactCandidateId, status: "promoted" },
      { id: mismatched.contactCandidateId, status: "candidate" },
    ]);

    expect(
      (
        await client.query(
          `SELECT user_id AS "userId", count(*)::integer AS count
             FROM backlink_recommendation_user_item_actions
            WHERE action_type='OPPORTUNITY_CREATED'
            GROUP BY user_id
            ORDER BY user_id`,
        )
      ).rows,
    ).toEqual([{ userId: actorA, count: 3 }]);
    expect(
      (
        await client.query(
          `SELECT successful_opportunity_count AS "successfulCount",
                  unlock_by_ratio AS "unlockByRatio",
                  unlock_by_elapsed AS "unlockByElapsed",
                  eligible
             FROM backlink_recommendation_batch_unlock_status(
               $1,$2,$3,$4,$5
             )`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            actorB,
            releaseBatchId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        successfulCount: 0,
        unlockByRatio: false,
        unlockByElapsed: false,
        eligible: false,
      },
    ]);

    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_opportunity_cycles)
               AS cycles,
             (SELECT count(*)::integer
                FROM backlink_lifecycle_events
               WHERE event_type='opportunity.created') AS lifecycle,
             (SELECT count(*)::integer
                FROM backlink_audit_events
               WHERE action='opportunity.created') AS audit,
             (SELECT count(*)::integer
                FROM backlink_idempotency_records
               WHERE command_type='opportunity.create.feed-item')
               AS idempotency`,
        )
      ).rows,
    ).toEqual([{ cycles: 3, lifecycle: 3, audit: 3, idempotency: 4 }]);
    expect(
      (
        await client.query(
          `SELECT after_state->>'recommendationFeedItemId'
                    AS "recommendationFeedItemId",
                  after_state->>'commercialCandidateId'
                    AS "commercialCandidateId",
                  after_state->>'inventoryId' AS "inventoryId",
                  after_state->>'generationContractId'
                    AS "generationContractId",
                  after_state->>'inputPinId' AS "inputPinId",
                  after_state->>'poolContractVersion'
                    AS "poolContractVersion",
                  after_state->>'projectContextVersion'
                    AS "projectContextVersion",
                  after_state->>'immutableFingerprint'
                    AS "immutableFingerprint",
                  after_state->>'selectedTargetUrl'
                    AS "selectedTargetUrl"
             FROM backlink_lifecycle_events
            WHERE aggregate_id=$1`,
          [createMatchingInput.opportunityId],
        )
      ).rows,
    ).toEqual([
      {
        recommendationFeedItemId: matching.itemId,
        commercialCandidateId: matching.commercialCandidateId,
        inventoryId: matching.inventoryId,
        generationContractId: generationId,
        inputPinId,
        poolContractVersion: "recommendation-pool.v2",
        projectContextVersion: "8",
        immutableFingerprint: "feed-opportunity-input-v2",
        selectedTargetUrl: "https://owner.test/resources",
      },
    ]);
    const opportunityQuery = createOpportunitiesQuery(client);
    const opportunityContext = {
      actor: createActorContext({
        userId: actorA,
        sessionId: "recommendation-feed-opportunity-query",
        roles: ["member"],
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
    expect(
      (
        await opportunityQuery.getOpportunity(
          opportunityContext,
          createMatchingInput.opportunityId,
        )
      ).selectionSnapshot.projectContextVersion,
    ).toBe(8);
    await client.query(
      `UPDATE backlink_lifecycle_events
          SET after_state=jsonb_set(
            after_state,
            '{projectContextVersion}',
            to_jsonb($2::text)
          )
        WHERE aggregate_id=$1
          AND event_type='opportunity.created'`,
      [createMatchingInput.opportunityId, recommendationContextVersionId],
    );
    expect(
      (
        await opportunityQuery.getOpportunity(
          opportunityContext,
          createMatchingInput.opportunityId,
        )
      ).selectionSnapshot.projectContextVersion,
    ).toBe(8);

    const releaseRepository = createRecommendationUserReleaseRepository(pool);
    const releaseScope = (actorId: string) => ({
      organizationId,
      workspaceId,
      websiteProjectId,
      actorId,
    });
    expect(
      await releaseRepository.publishInitial(releaseScope(actorA)),
    ).toEqual({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: true,
    });
    expect(
      await releaseRepository.publishInitial(releaseScope(actorB)),
    ).toEqual({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: true,
    });
    expect(
      await releaseRepository.publishInitial(releaseScope(actorC)),
    ).toEqual({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: false,
    });
    expect(
      await releaseRepository.publishInitial(releaseScope(actorC)),
    ).toEqual({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: true,
    });
    const actorAStatus = await releaseRepository.getStatus(
      releaseScope(actorA),
    );
    expect(actorAStatus).toMatchObject({
      currentBatchOrdinal: 1,
      originalBatchSize: 3,
      successfulOpportunityCount: 3,
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "AVAILABLE",
    });
    expect(actorAStatus?.firstVisibleAt).toBeInstanceOf(Date);
    expect(actorAStatus?.databaseNow).toBeInstanceOf(Date);
    expect(
      actorAStatus === null
        ? null
        : actorAStatus.databaseNow.getTime() -
            actorAStatus.firstVisibleAt.getTime(),
    ).toBeGreaterThanOrEqual(0);
    expect(
      await releaseRepository.getStatus(releaseScope(actorC)),
    ).toMatchObject({
      currentBatchOrdinal: 1,
      originalBatchSize: 3,
      successfulOpportunityCount: 0,
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "AVAILABLE",
    });

    const sideEffectCounts = async () =>
      (
        await client.query(
          `SELECT
           (SELECT count(*)::integer FROM backlink_jobs) AS jobs,
           (SELECT count(*)::integer FROM backlink_outbox_events) AS outbox,
           (SELECT count(*)::integer
              FROM backlink_provider_usage_ledger) AS provider`,
        )
      ).rows[0];
    const beforeReleaseSideEffects = await sideEffectCounts();

    await client.query(
      `UPDATE backlink_opportunities
          SET management_status='ARCHIVED',
              version=version+1,
              updated_at=statement_timestamp(),
              updated_by=$2
        WHERE id=$1`,
      [createMatchingInput.opportunityId, actorA],
    );
    expect(
      (
        await client.query(
          `SELECT successful_opportunity_count AS "successfulCount",
                  required_opportunity_count AS "requiredCount",
                  eligible
             FROM backlink_recommendation_batch_unlock_status(
               $1,$2,$3,$4,$5
             )`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            actorA,
            releaseBatchId,
          ],
        )
      ).rows,
    ).toEqual([{ successfulCount: 3, requiredCount: 1, eligible: true }]);

    const archiveInput = {
      ...releaseScope(actorA),
      itemId: missing.itemId,
      archived: true,
      idempotencyKey: "archive-missing-v2",
      requestHash: "archive-missing-v2-hash",
    } as const;
    expect(await releaseRepository.setArchived(archiveInput)).toEqual({
      itemId: missing.itemId,
      archived: true,
      replayed: false,
    });
    expect(await releaseRepository.setArchived(archiveInput)).toEqual({
      itemId: missing.itemId,
      archived: true,
      replayed: true,
    });
    expect(
      await releaseRepository.setArchived({
        ...archiveInput,
        archived: false,
        idempotencyKey: "unarchive-missing-v2",
        requestHash: "unarchive-missing-v2-hash",
      }),
    ).toEqual({
      itemId: missing.itemId,
      archived: false,
      replayed: false,
    });

    const actorAGetMore = {
      ...releaseScope(actorA),
      idempotencyKey: "get-more-actor-a-v2",
      requestHash: "get-more-actor-a-v2-hash",
    } as const;
    const concurrentActorARelease = await Promise.all([
      releaseRepository.getMore(actorAGetMore),
      releaseRepository.getMore(actorAGetMore),
    ]);
    expect(
      concurrentActorARelease.map(
        ({ state, currentBatchOrdinal, releasedBatchOrdinal }) => ({
          state,
          currentBatchOrdinal,
          releasedBatchOrdinal,
        }),
      ),
    ).toEqual([
      { state: "RELEASED", currentBatchOrdinal: 1, releasedBatchOrdinal: 2 },
      { state: "RELEASED", currentBatchOrdinal: 1, releasedBatchOrdinal: 2 },
    ]);
    expect(
      concurrentActorARelease.map(({ replayed }) => replayed).sort(),
    ).toEqual([false, true]);

    expect(
      await releaseRepository.getMore({
        ...releaseScope(actorC),
        idempotencyKey: "get-more-actor-c-v2",
        requestHash: "get-more-actor-c-v2-hash",
      }),
    ).toEqual({
      state: "NOT_UNLOCKED",
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: null,
      replayed: false,
    });

    await client.query("SET session_replication_role='replica'");
    try {
      await client.query(
        `UPDATE backlink_recommendation_user_publications
            SET first_visible_at=statement_timestamp()-interval '18 hours'
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND user_id=$4 AND batch_id=$5`,
        [organizationId, workspaceId, websiteProjectId, actorB, releaseBatchId],
      );
    } finally {
      await client.query("SET session_replication_role='origin'");
    }
    expect(
      await releaseRepository.getMore({
        ...releaseScope(actorB),
        idempotencyKey: "get-more-actor-b-elapsed-v2",
        requestHash: "get-more-actor-b-elapsed-v2-hash",
      }),
    ).toEqual({
      state: "RELEASED",
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: 2,
      replayed: false,
    });
    expect(
      (
        await client.query(
          `SELECT reason
             FROM backlink_recommendation_user_unlocks
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND user_id=$4 AND batch_id=$5`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            actorB,
            releaseBatchId,
          ],
        )
      ).rows,
    ).toEqual([{ reason: "ELAPSED_18H" }]);

    const nextOpportunityInput = commandInput(9, actorA, nextBatchItem.itemId);
    expect(
      await repository.createFromRecommendationFeedItem(nextOpportunityInput),
    ).toMatchObject({
      state: "completed",
      responseBody: {
        recommendationFeedItemId: nextBatchItem.itemId,
        contactReviewRequired: false,
        createdByCurrentUser: true,
      },
    });
    await client.query(
      `UPDATE backlink_opportunities
          SET management_status='ARCHIVED',
              version=version+1,
              updated_at=statement_timestamp(),
              updated_by=$2
        WHERE id=$1`,
      [nextOpportunityInput.opportunityId, actorA],
    );
    expect(
      await releaseRepository.getMore({
        ...releaseScope(actorA),
        idempotencyKey: "get-more-actor-a-exhausted-v2",
        requestHash: "get-more-actor-a-exhausted-v2-hash",
      }),
    ).toEqual({
      state: "POOL_EXHAUSTED",
      currentBatchOrdinal: 2,
      releasedBatchOrdinal: null,
      replayed: false,
    });
    expect(
      await releaseRepository.getMore({
        ...releaseScope(actorA),
        idempotencyKey: "get-more-actor-a-exhausted-v2",
        requestHash: "get-more-actor-a-exhausted-v2-hash",
      }),
    ).toEqual({
      state: "POOL_EXHAUSTED",
      currentBatchOrdinal: 2,
      releasedBatchOrdinal: null,
      replayed: true,
    });

    expect(await sideEffectCounts()).toEqual(beforeReleaseSideEffects);
    expect(
      (
        await client.query(
          `SELECT user_id AS "userId",
                  highest_published_batch_ordinal AS "batchOrdinal"
             FROM backlink_recommendation_user_cursors
            ORDER BY user_id`,
        )
      ).rows,
    ).toEqual([
      { userId: actorA, batchOrdinal: 2 },
      { userId: actorB, batchOrdinal: 2 },
      { userId: actorC, batchOrdinal: 1 },
    ]);
    expect(
      (
        await client.query(
          `SELECT user_id AS "userId", count(*)::integer AS count
             FROM backlink_recommendation_user_publications
            GROUP BY user_id
            ORDER BY user_id`,
        )
      ).rows,
    ).toEqual([
      { userId: actorA, count: 2 },
      { userId: actorB, count: 2 },
      { userId: actorC, count: 1 },
    ]);
    expect(
      (
        await client.query(
          `SELECT user_id AS "userId", action_type AS "actionType",
                  count(*)::integer AS count
             FROM backlink_recommendation_user_item_actions
            WHERE action_type IN ('ARCHIVED','UNARCHIVED','GET_MORE')
            GROUP BY user_id,action_type
            ORDER BY user_id,action_type`,
        )
      ).rows,
    ).toEqual([
      { userId: actorA, actionType: "ARCHIVED", count: 1 },
      { userId: actorA, actionType: "GET_MORE", count: 1 },
      { userId: actorA, actionType: "UNARCHIVED", count: 1 },
      { userId: actorB, actionType: "GET_MORE", count: 1 },
    ]);

    expect(
      (
        await client.query(
          `SELECT
             (SELECT jsonb_agg(status ORDER BY id)
                FROM backlink_recommendations) AS recommendations,
             (SELECT jsonb_agg(status ORDER BY id)
                FROM backlink_recommendation_inventory) AS inventory,
             (SELECT jsonb_agg(
                jsonb_build_object(
                  'userId',user_id,
                  'state',publication_state,
                  'version',version
                ) ORDER BY user_id
              )
                FROM backlink_recommendation_user_publications)
               AS publications,
             (SELECT count(*)::integer
                FROM backlink_recommendation_user_cursors) AS cursors,
             (SELECT count(*)::integer
                FROM backlink_recommendation_user_item_actions
               WHERE action_type IN ('ARCHIVED','UNARCHIVED')) AS archives`,
        )
      ).rows,
    ).toEqual([
      {
        recommendations: ["shown", "shown", "shown", "shown"],
        inventory: ["shown", "shown", "shown", "shown"],
        publications: [
          { userId: actorA, state: "ACTIVE", version: 1 },
          { userId: actorA, state: "ACTIVE", version: 1 },
          { userId: actorB, state: "ACTIVE", version: 1 },
          { userId: actorB, state: "ACTIVE", version: 1 },
          { userId: actorC, state: "ACTIVE", version: 1 },
        ],
        cursors: 3,
        archives: 2,
      },
    ]);
  }, 120_000);
});
