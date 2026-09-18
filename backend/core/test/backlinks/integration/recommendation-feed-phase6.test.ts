import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRecommendationFeedQuery,
  normalizeRecommendationFeedFilters,
} from "../../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import { applyBacklinksDeploymentManifest } from "../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";
import { createRecommendationFeedRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-feed.repository.js";
import { createRecommendationUserReleaseRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import { createOpportunityFromRecommendationFeedItem } from "../../../src/modules/backlinks/db/repositories/opportunity-recommendation-v2.repository.js";
import type { BacklinkTenantPool } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
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
  `019b0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const otherOrganizationId = id(4);
const otherWorkspaceId = id(5);
const otherProjectId = id(6);
const actorA = "phase6-actor-a";
const actorB = "phase6-actor-b";
const actorWithoutPublication = "phase6-actor-hidden";

type Lineage = Readonly<{
  outreachProfileId: string;
  inputPinId: string;
  contextId: string;
  generationId: string;
  blueprintId: string;
  discoveryBatchId: string;
  visiblePoolGeneration: number;
  projectContextVersion: number;
  fingerprint: string;
}>;

const currentLineage: Lineage = {
  outreachProfileId: id(10),
  inputPinId: id(11),
  contextId: id(12),
  generationId: id(13),
  blueprintId: id(14),
  discoveryBatchId: id(15),
  visiblePoolGeneration: 2,
  projectContextVersion: 8,
  fingerprint: "phase6-current",
};
const staleLineage: Lineage = {
  outreachProfileId: id(20),
  inputPinId: id(21),
  contextId: id(22),
  generationId: id(23),
  blueprintId: id(24),
  discoveryBatchId: id(25),
  visiblePoolGeneration: 1,
  projectContextVersion: 7,
  fingerprint: "phase6-stale",
};

const currentBatchOneId = id(30);
const currentBatchTwoId = id(31);
const unpublishedBatchId = id(32);
const preparingBatchId = id(33);
const staleBatchId = id(34);
const projectContractId = id(35);

function metricSnapshot(metric: string, value: number | null): string {
  return JSON.stringify({
    value,
    provider: "fixture",
    endpoint: `fixture/${metric}`,
    market: "US",
    location: "United States",
    language: "en",
    observedAt: "2026-08-31T00:00:00.000Z",
    artifactRef: `phase6-feed:${metric}:${String(value)}`,
  });
}

function resolvedContext(
  actorId: string,
  overrides: Partial<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
  }> = {},
) {
  return {
    actor: createActorContext({
      userId: actorId,
      sessionId: `session:${actorId}`,
      roles: ["member"],
    }),
    tenant: createTenantContext({
      organizationId: overrides.organizationId ?? organizationId,
      workspaceId: overrides.workspaceId ?? workspaceId,
    }),
    project: createProjectContext({
      websiteProjectId: overrides.websiteProjectId ?? websiteProjectId,
      canonicalDomain: "owner.test",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "site-profile-v2",
      promotionTargetVersionId: "promotion-target-v2",
    }),
  };
}

async function seedLineage(client: Client, lineage: Lineage): Promise<void> {
  await client.query(
    `INSERT INTO backlink_outreach_profile_versions (
       id, organization_id, workspace_id, website_project_id,
       profile_version_id, promotion_target_version_id,
       keywords_and_topics, products_and_services, target_urls,
       target_audiences, partnership_goals, market, location, language,
       authorized_discovery_sources, immutable_fingerprint, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'promotion-target-v2',
       '["technical seo"]'::jsonb, '["seo platform"]'::jsonb,
       '["https://owner.test/resources"]'::jsonb,
       '["publishers"]'::jsonb, '["editorial coverage"]'::jsonb,
       'US', 'United States', 'en', '["fixture"]'::jsonb, $6, 'fixture'
     )`,
    [
      lineage.outreachProfileId,
      organizationId,
      workspaceId,
      websiteProjectId,
      `profile-${lineage.visiblePoolGeneration}`,
      `${lineage.fingerprint}-outreach`,
    ],
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
       $1, $2, $3, $4, $5, 'site-profile-v2', $6,
       'promotion-target-v2', '[]'::jsonb, '[]'::jsonb, 'US',
       'recommendation-pool-admission.v2', $7, 'fixture'
     )`,
    [
      lineage.inputPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.projectContextVersion,
      lineage.outreachProfileId,
      `${lineage.fingerprint}-input`,
    ],
  );
  await client.query(
    `INSERT INTO backlink_project_context_snapshots (
       id, organization_id, workspace_id, website_project_id,
       snapshot_version, project_status, canonical_domain, locale,
       country_code, profile_version_id, promotion_target_version_id,
       products, keywords, target_urls, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'ACTIVE', 'owner.test', 'en-US', 'US',
       'site-profile-v2', 'promotion-target-v2',
       '["seo platform"]'::jsonb, '["technical seo"]'::jsonb,
       '["https://owner.test/resources"]'::jsonb, 'fixture'
     )`,
    [
      lineage.contextId,
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.projectContextVersion,
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
       $1, $2, $3, $4, $5, $6, $7,
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
      lineage.generationId,
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.contextId,
      lineage.visiblePoolGeneration,
      lineage.inputPinId,
    ],
  );
  await client.query(
    `UPDATE backlink_recommendation_generation_contracts
        SET effective_unique_candidate_count=10,
            canonical_batch_size=10,
            canonical_batch_count=5,
            canonical_order_fingerprint=$2,
            discovery_terminal_reason='BUDGET_COMPLETE',
            discovery_completed_at=statement_timestamp()
      WHERE id=$1`,
    [lineage.generationId, `${lineage.fingerprint}-order`],
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
      lineage.blueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.contextId,
    ],
  );
  await client.query(
    `INSERT INTO backlink_commercial_discovery_batches (
       id, organization_id, workspace_id, website_project_id, blueprint_id,
       project_context_version_id, status, idempotency_key, request_intent,
       source_types, provider_request_fingerprints, paid_cost_micros,
       started_at, finished_at, created_by, visible_pool_generation
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'completed', $7, 'DISCOVERY',
       '["EXISTING_HISTORY"]'::jsonb, '[]'::jsonb, 0,
       statement_timestamp(), statement_timestamp(), 'fixture', $8
     )`,
    [
      lineage.discoveryBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.blueprintId,
      lineage.contextId,
      `${lineage.fingerprint}-discovery`,
      lineage.visiblePoolGeneration,
    ],
  );
}

async function seedBatch(
  client: Client,
  input: Readonly<{
    batchId: string;
    lineage: Lineage;
    ordinal: number;
    state: "PREPARING" | "AVAILABLE";
    availableAt: string;
    items: readonly Readonly<{
      sequence: number;
      domain: string;
      recommended: boolean;
      category: string | null;
      traffic: number | null;
      rank: number | null;
      spam: number | null;
    }>[];
  }>,
): Promise<readonly string[]> {
  await client.query(
    `INSERT INTO backlink_recommendation_release_batches (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       visible_pool_generation, input_pin_id, batch_ordinal, state,
       original_batch_size, selection_policy_version, order_fingerprint,
       contact_total_count, preparation_started_at, deadline_at,
       created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, 'PREPARING', $10,
       'recommendation-release-selection.v2', $11, $10,
       $12::timestamptz - interval '1 hour',
       $12::timestamptz + interval '18 hours', 'fixture', 'fixture'
     )`,
    [
      input.batchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      input.lineage.generationId,
      input.lineage.contextId,
      input.lineage.visiblePoolGeneration,
      input.lineage.inputPinId,
      input.ordinal,
      input.items.length,
      `${input.lineage.fingerprint}-batch-${input.ordinal}`,
      input.availableAt,
    ],
  );

  const itemIds: string[] = [];
  for (const [index, item] of input.items.entries()) {
    const itemId = id(1000 + item.sequence * 10);
    const prospectId = id(1001 + item.sequence * 10);
    const recommendationId = id(1002 + item.sequence * 10);
    const inventoryId = id(1003 + item.sequence * 10);
    const candidateId = id(1004 + item.sequence * 10);
    const generationCandidateId = id(1005 + item.sequence * 10);
    itemIds.push(itemId);
    await client.query(
      `INSERT INTO backlink_prospects (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, hostname_ascii,
         registrable_domain, normalization_version, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'tldts-v1', 'fixture', 'fixture'
       )`,
      [
        prospectId,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.lineage.contextId,
        `www.${item.domain}`,
        item.domain,
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
         $7, $8, $9, 'recommendation-pool.v2',
         'recommendation-pool-materialization.v2'
       )`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        input.lineage.contextId,
        input.lineage.generationId,
        input.lineage.visiblePoolGeneration,
        input.lineage.inputPinId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_inventory (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id,
         recommendation_context_version_id, visible_pool_generation,
         status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'shown', 'fixture', 'fixture'
       )`,
      [
        inventoryId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        input.lineage.contextId,
        input.lineage.visiblePoolGeneration,
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
         '{"decision":"eligible","total":72,"scoreModelVersion":"recommendation-commercial-fit.v4","ruleVersion":"recommendation-commercial-fit-rules.v4.2","admission":{"appliedThreshold":50}}'::jsonb,
         'recommendation-commercial-fit.v4', 'candidate_ready',
         statement_timestamp(), 'fixture', 'fixture', $11
       )`,
      [
        candidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.lineage.blueprintId,
        input.lineage.discoveryBatchId,
        recommendationId,
        prospectId,
        input.lineage.contextId,
        item.domain,
        input.lineage.visiblePoolGeneration,
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
         $1, $2, $3, $4, $5, $6, $7, $8, 'recommendation-pool.v2',
         $9, 'ADMITTED', 'recommendation-pool-admission.v2', '{}'::jsonb,
         '{"contractVersion":"recommendation-pool-admission.v2","passedRequiredExclusions":true}'::jsonb,
         'EXISTING_HISTORY', $10, '["PUBLIC_REASON"]'::jsonb,
         statement_timestamp(), statement_timestamp(), statement_timestamp(),
         'fixture'
       )`,
      [
        generationCandidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.lineage.generationId,
        input.lineage.contextId,
        input.lineage.visiblePoolGeneration,
        input.lineage.inputPinId,
        item.domain,
        item.recommended,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_release_batch_items (
         id, organization_id, workspace_id, website_project_id, batch_id,
         recommendation_context_version_id, visible_pool_generation,
         candidate_id, generation_candidate_id, recommendation_id, prospect_id,
         inventory_id,
         generation_contract_id, input_pin_id, canonical_domain, position,
         recommended, recommendation_reason_codes,
         recommendation_marker_version, traffic_snapshot, rank_snapshot,
         spam_snapshot, traffic_organic_etv, authority_rank, spam_score,
         primary_category, category_snapshot,
         contact_terminal_reason_at_release, contact_completed_at_release,
         created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, '["PUBLIC_REASON"]'::jsonb, 'recommendation-marker.v2',
         $18::jsonb, $19::jsonb, $20::jsonb, $21, $22, $23, $24,
         CASE WHEN $24::text IS NULL THEN NULL
              ELSE jsonb_build_object('category',$24::text) END,
         'NO_PUBLIC_CONTACT', statement_timestamp(), 'fixture'
       )`,
      [
        itemId,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.batchId,
        input.lineage.contextId,
        input.lineage.visiblePoolGeneration,
        candidateId,
        generationCandidateId,
        recommendationId,
        prospectId,
        inventoryId,
        input.lineage.generationId,
        input.lineage.inputPinId,
        item.domain,
        index + 1,
        item.recommended,
        metricSnapshot("traffic", item.traffic),
        metricSnapshot("rank", item.rank),
        metricSnapshot("spam", item.spam),
        item.traffic,
        item.rank,
        item.spam,
        item.category,
      ],
    );
  }

  if (input.state === "AVAILABLE") {
    await client.query(
      `UPDATE backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=contact_total_count,
              available_at=$2::timestamptz,
              updated_at=statement_timestamp(),
              updated_by='fixture',
              version=2
        WHERE id=$1`,
      [input.batchId, input.availableAt],
    );
  }
  return itemIds;
}

async function publish(
  client: Client,
  sequence: number,
  actorId: string,
  batchId: string,
  lineage: Lineage,
): Promise<void> {
  await client.query(
    `INSERT INTO backlink_recommendation_user_publications (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, visible_pool_generation,
       user_id, batch_id, published_by_command_id, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'fixture','fixture')`,
    [
      id(500 + sequence),
      organizationId,
      workspaceId,
      websiteProjectId,
      lineage.contextId,
      lineage.visiblePoolGeneration,
      actorId,
      batchId,
      `phase6-publish-${sequence}`,
    ],
  );
}

async function readPublicationVisibleAt(
  client: Client,
  actorId: string,
  batchId: string,
): Promise<string> {
  const result = await client.query(
    `SELECT first_visible_at
       FROM backlink_recommendation_user_publications
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND user_id=$4
        AND batch_id=$5`,
    [organizationId, workspaceId, websiteProjectId, actorId, batchId],
  );
  const value = result.rows[0]?.first_visible_at;
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

async function readSideEffectCounts(client: Client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*) FROM backlink_recommendation_user_publications)::int publications,
      (SELECT count(*) FROM backlink_recommendation_user_cursors)::int cursors,
      (SELECT count(*) FROM backlink_recommendation_user_unlocks)::int unlocks,
      (SELECT count(*) FROM backlink_recommendation_user_item_actions)::int actions,
      (SELECT count(*) FROM backlink_outbox_events)::int outbox,
      (SELECT count(*) FROM backlink_contact_enrichment_jobs)::int contact_jobs,
      (SELECT count(*) FROM backlink_provider_usage_ledger)::int provider_ledger
  `);
  return result.rows[0];
}

describe("Phase 6 released recommendation feed PostgreSQL boundary", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: Pool;
  let query: ReturnType<typeof createRecommendationFeedQuery>;
  let repository: ReturnType<typeof createRecommendationFeedRepository>;
  let alphaItemId: string;
  let gammaItemId: string;
  let unpublishedItemId: string;
  let actorABatchOneReleasedAt: string;
  let actorABatchTwoReleasedAt: string;
  let actorAStaleBatchReleasedAt: string;
  let actorBBatchTwoReleasedAt: string;

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
    // Historical fixtures precede V1 write retirement; apply only the new
    // additive read/unlock migration to test their forward compatibility.
    await applyBacklinksDeploymentManifest({
      query: (sql) => client.query(sql),
      startRevision: "0100",
      targetRevision: "0100",
    });
    await applyBacklinksDeploymentManifest({
      query: (sql) => client.query(sql),
      startRevision: "0103",
      targetRevision: "0103",
    });
    await client.query("SET search_path = backlinks, pg_catalog");
    pool = new PgPool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,pg_catalog",
    });
    repository = createRecommendationFeedRepository(
      pool as unknown as BacklinkTenantPool,
    );
    query = createRecommendationFeedQuery(repository, {
      cursorSigningKey: "phase6-integration-secret",
    });

    await seedLineage(client, staleLineage);
    await seedLineage(client, currentLineage);
    await client.query(
      `INSERT INTO backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, state_reason_codes, activated_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation-pool.v2','V2_ACTIVE',$5,$6,$7,$8,
         '[]'::jsonb,statement_timestamp(),'fixture','fixture'
       )`,
      [
        projectContractId,
        organizationId,
        workspaceId,
        websiteProjectId,
        currentLineage.generationId,
        currentLineage.contextId,
        currentLineage.visiblePoolGeneration,
        currentLineage.inputPinId,
      ],
    );

    [alphaItemId] = await seedBatch(client, {
      batchId: currentBatchOneId,
      lineage: currentLineage,
      ordinal: 1,
      state: "AVAILABLE",
      availableAt: "2026-08-31T01:00:00.000Z",
      items: [
        {
          sequence: 1,
          domain: "alpha.test",
          recommended: true,
          category: "editorial",
          traffic: 100,
          rank: 50,
          spam: 3,
        },
        {
          sequence: 2,
          domain: "beta.test",
          recommended: false,
          category: "resource",
          traffic: null,
          rank: 50,
          spam: null,
        },
      ],
    });
    const secondItems = await seedBatch(client, {
      batchId: currentBatchTwoId,
      lineage: currentLineage,
      ordinal: 2,
      state: "AVAILABLE",
      availableAt: "2026-08-31T02:00:00.000Z",
      items: [
        {
          sequence: 3,
          domain: "gamma.test",
          recommended: true,
          category: "editorial",
          traffic: 100,
          rank: 40,
          spam: 10,
        },
        {
          sequence: 4,
          domain: "archived.test",
          recommended: true,
          category: "editorial",
          traffic: 20,
          rank: 10,
          spam: 20,
        },
      ],
    });
    gammaItemId = secondItems[0] as string;
    const archivedItemId = secondItems[1] as string;
    [unpublishedItemId] = await seedBatch(client, {
      batchId: unpublishedBatchId,
      lineage: currentLineage,
      ordinal: 3,
      state: "AVAILABLE",
      availableAt: "2026-08-31T03:00:00.000Z",
      items: [
        {
          sequence: 5,
          domain: "hidden.test",
          recommended: true,
          category: "editorial",
          traffic: 500,
          rank: 99,
          spam: 1,
        },
      ],
    });
    await seedBatch(client, {
      batchId: preparingBatchId,
      lineage: currentLineage,
      ordinal: 4,
      state: "PREPARING",
      availableAt: "2026-08-31T04:00:00.000Z",
      items: [
        {
          sequence: 6,
          domain: "preparing.test",
          recommended: true,
          category: "editorial",
          traffic: 600,
          rank: 100,
          spam: 0,
        },
      ],
    });
    await seedBatch(client, {
      batchId: staleBatchId,
      lineage: staleLineage,
      ordinal: 1,
      state: "AVAILABLE",
      availableAt: "2026-08-30T01:00:00.000Z",
      items: [
        {
          sequence: 7,
          domain: "stale.test",
          recommended: true,
          category: "editorial",
          traffic: 700,
          rank: 100,
          spam: 0,
        },
      ],
    });

    await publish(client, 1, actorA, currentBatchOneId, currentLineage);
    actorABatchOneReleasedAt = await readPublicationVisibleAt(
      client,
      actorA,
      currentBatchOneId,
    );
    await client.query("SELECT pg_sleep(0.01)");
    await publish(client, 2, actorA, currentBatchTwoId, currentLineage);
    actorABatchTwoReleasedAt = await readPublicationVisibleAt(
      client,
      actorA,
      currentBatchTwoId,
    );
    await client.query("SELECT pg_sleep(0.01)");
    await publish(client, 4, actorA, staleBatchId, staleLineage);
    actorAStaleBatchReleasedAt = await readPublicationVisibleAt(
      client,
      actorA,
      staleBatchId,
    );
    await client.query("SELECT pg_sleep(0.01)");
    await publish(client, 5, actorB, currentBatchTwoId, currentLineage);
    actorBBatchTwoReleasedAt = await readPublicationVisibleAt(
      client,
      actorB,
      currentBatchTwoId,
    );
    await client.query(
      `INSERT INTO backlink_recommendation_user_item_actions (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, batch_id, batch_item_id, action_type,
         idempotency_key, request_hash, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'ARCHIVED',
         'phase6-archive','phase6-archive-hash','fixture'
       )`,
      [
        id(600),
        organizationId,
        workspaceId,
        websiteProjectId,
        currentLineage.contextId,
        currentLineage.visiblePoolGeneration,
        actorA,
        currentBatchTwoId,
        archivedItemId,
      ],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("projects later verified contacts without changing release audit facts", async () => {
    const actor = "late-contact-actor";
    const batchId = id(9000);
    const [itemId] = await seedBatch(client, {
      batchId, lineage: currentLineage, ordinal: 13,
      state: "AVAILABLE", availableAt: "2026-08-31T05:00:00.000Z",
      items: [{
        sequence: 800, domain: "late-publisher.com", recommended: true,
        category: "editorial", traffic: null, rank: null, spam: null,
      }],
    });
    await publish(client, 102, actor, batchId, currentLineage);
    const auditQuery =
      "SELECT * FROM backlink_recommendation_release_batch_items WHERE id=$1";
    const auditBefore = await client.query(auditQuery, [itemId]);
    const initial = await query.list(resolvedContext(actor), {});
    expect(initial.items[0]?.contact.email).toBeNull();
    await client.query(
      `INSERT INTO backlink_contact_candidates (
         id,organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id,normalized_email,email_domain_ascii,
         domain_relation,syntax_validator_version,confidence,guessed,status,
         inferred_purpose,purpose_confidence,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'editor@late-publisher.com','late-publisher.com',
         'same_registrable_domain','email-syntax.v1',95,false,'candidate',
         'editorial',95,'fixture','fixture')`,
      [id(9900), organizationId, workspaceId, websiteProjectId,
        id(9001), currentLineage.contextId],
    );
    await client.query(
      `INSERT INTO backlink_contact_evidence (
         id,organization_id,workspace_id,website_project_id,candidate_id,
         source_url,observed_at,extraction_method,evidence_snippet,
         parser_version,content_sha256,confidence,expires_at,created_by
       ) VALUES ($1,$2,$3,$4,$5,'https://late-publisher.com/contact',
         statement_timestamp(),'visible_text','editor@late-publisher.com',
         'contact-parser.v1',repeat('b',64),95,
         statement_timestamp()+interval '30 days','fixture')`,
      [id(9901), organizationId, workspaceId, websiteProjectId, id(9900)],
    );
    const enriched = await query.list(resolvedContext(actor), {});
    expect(enriched.items[0]?.contact).toEqual({
      email: "editor@late-publisher.com",
      contactPage: "https://late-publisher.com/contact",
      outcome: "PUBLIC_EMAIL_FOUND",
    });
    expect((await query.export(resolvedContext(actor), {})).content)
      .toContain("editor@late-publisher.com");
    const created = await createOpportunityFromRecommendationFeedItem(client, {
      organizationId, workspaceId, websiteProjectId, actorId: actor,
      recommendationFeedItemId: itemId!,
      idempotencyKey: "late-contact-create", requestHash: "late-contact-create",
      requestId: id(9950), idempotencyRecordId: id(9951),
      opportunityId: id(9952), cycleId: id(9953),
      lifecycleEventId: id(9954), auditEventId: id(9955),
      contactId: id(9956), opportunityCreatedActionId: id(9957),
    });
    expect(created.responseBody).toMatchObject({
      contactCandidateId: id(9900), contactReviewRequired: false,
    });
    const confirmed = await client.query(
      "SELECT normalized_email,status,guessed FROM backlink_contacts WHERE id=$1",
      [id(9956)],
    );
    expect(confirmed.rows).toEqual([{
      normalized_email: "editor@late-publisher.com", status: "active", guessed: false,
    }]);
    for (const [column, invalid, valid] of [
      ["guessed", true, false],
      ["inferred_purpose", "support", "editorial"],
      ["confidence", 79, 95],
      ["purpose_confidence", 69, 95],
    ] as const) {
      await client.query(
        `UPDATE backlink_contact_candidates SET ${column}=$1 WHERE id=$2`,
        [invalid, id(9900)],
      );
      expect((await query.list(resolvedContext(actor), {})).items[0]?.contact.email)
        .toBeNull();
      await client.query(
        `UPDATE backlink_contact_candidates SET ${column}=$1 WHERE id=$2`,
        [valid, id(9900)],
      );
    }
    await expect(client.query(
      "UPDATE backlink_contact_candidates SET recommendation_context_version_id=$1 WHERE id=$2",
      [staleLineage.contextId, id(9900)],
    )).rejects.toMatchObject({ code: "23503" });
    await client.query(
      "UPDATE backlink_contact_evidence SET observed_at=statement_timestamp()-interval '2 days', expires_at=statement_timestamp()-interval '1 day' WHERE id=$1",
      [id(9901)],
    );
    expect((await query.list(resolvedContext(actor), {})).items[0]?.contact.email)
      .toBeNull();
    expect((await client.query(auditQuery, [itemId])).rows).toEqual(auditBefore.rows);
  });

  it("removes non-outreach targets from historical reads and exports without deleting audit items", async () => {
    const actor = "outreach-policy-actor";
    const batchId = id(3000);
    const itemIds = await seedBatch(client, {
      batchId,
      lineage: currentLineage,
      ordinal: 10,
      state: "AVAILABLE",
      availableAt: "2026-08-31T03:00:00.000Z",
      items: ["amazon.com", "developer.android.com", "apple.com", "publisher.test"].map((domain, index) => ({
        sequence: 100 + index, domain, recommended: true, category: "editorial",
        traffic: null, rank: null, spam: null,
      })),
    });
    await publish(client, 99, actor, batchId, currentLineage);
    const before = await readSideEffectCounts(client);
    const result = await query.list(resolvedContext(actor), { limit: 100 });
    expect(result.totalCount).toBe(1);
    expect(result.items.map(({ domain }) => domain)).toEqual(["publisher.test"]);
    const exported = await query.export(resolvedContext(actor), {});
    expect(exported.content).toContain("publisher.test");
    expect(exported.content).not.toMatch(/amazon\.com|android\.com|apple\.com/);
    await expect(query.export(resolvedContext(actor), {
      selectedItemIds: itemIds.slice(0, 1),
    })).rejects.toBeInstanceOf(BacklinkError);
    for (const [index, recommendationFeedItemId] of itemIds.slice(0, 3).entries()) {
      const denied = await createOpportunityFromRecommendationFeedItem(client, {
        organizationId, workspaceId, websiteProjectId, actorId: actor,
        recommendationFeedItemId,
        idempotencyKey: `blocked-target-${index}`, requestHash: `blocked-target-${index}`,
        requestId: id(4000 + index * 10), idempotencyRecordId: id(4001 + index * 10),
        opportunityId: id(4002 + index * 10), cycleId: id(4003 + index * 10),
        lifecycleEventId: id(4004 + index * 10), auditEventId: id(4005 + index * 10),
        contactId: id(4006 + index * 10), opportunityCreatedActionId: id(4007 + index * 10),
      });
      expect(denied.state).toBe("not_found");
    }
    expect(await readSideEffectCounts(client)).toEqual(before);
    const audit = await client.query(
      "SELECT count(*)::int AS count FROM backlink_recommendation_release_batch_items WHERE batch_id=$1",
      [batchId],
    );
    expect(audit.rows[0]?.count).toBe(4);
  });

  it("fills default 35-row pages from all eligible history rather than filtering each page afterward", async () => {
    const actor = "whole-supply-actor";
    const batchId = id(3100);
    await seedBatch(client, {
      batchId, lineage: currentLineage, ordinal: 11,
      state: "AVAILABLE", availableAt: "2026-08-31T04:00:00.000Z",
      items: Array.from({ length: 100 }, (_, index) => ({
        sequence: 500 + index,
        domain: index % 5 === 0 ? `shop${index}.amazon.com` : `publisher-${String(index).padStart(3, "0")}.com`,
        recommended: true, category: "editorial", traffic: null, rank: null, spam: null,
      })),
    });
    await publish(client, 100, actor, batchId, currentLineage);
    const domains: string[] = [];
    let cursor: string | undefined;
    for (const count of [35, 35, 10]) {
      const result = await query.list(resolvedContext(actor), { sort: "domain_asc", cursor });
      expect(result.totalCount).toBe(80);
      expect(result.items).toHaveLength(count);
      domains.push(...result.items.map((item) => item.domain));
      cursor = result.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(domains).size).toBe(80);
    expect(domains.some((domain) => domain.endsWith(".amazon.com"))).toBe(false);
  });

  it("paginates a 100-item batch as 35/35/30 without duplicate rows", async () => {
    const actor = "hundred-item-actor";
    const batchId = id(3200);
    await seedBatch(client, {
      batchId, lineage: currentLineage, ordinal: 12,
      state: "AVAILABLE", availableAt: "2026-08-31T05:00:00.000Z",
      items: Array.from({ length: 100 }, (_, index) => ({
        sequence: 1000 + index,
        domain: `hundred-${String(index).padStart(3, "0")}.com`,
        recommended: true, category: "editorial", traffic: null, rank: null, spam: null,
      })),
    });
    await publish(client, 101, actor, batchId, currentLineage);
    const eligibility = await client.query(
      `SELECT * FROM backlink_recommendation_batch_unlock_status($1,$2,$3,$4,$5)`,
      [organizationId, workspaceId, websiteProjectId, actor, batchId],
    );
    expect(eligibility.rows[0]).toMatchObject({
      original_batch_size: 100, required_opportunity_count: 0,
      successful_opportunity_count: 0, eligible: true, reason: "NO_GATE",
      unlock_by_ratio: false, unlock_by_elapsed: false,
    });
    const unentitled = await client.query(
      `SELECT * FROM backlink_recommendation_batch_unlock_status($1,$2,$3,$4,$5)`,
      [organizationId, workspaceId, websiteProjectId, actorWithoutPublication, batchId],
    );
    expect(unentitled.rows).toHaveLength(0);
    const ids: string[] = [];
    let cursor: string | undefined;
    const before = await readSideEffectCounts(client);
    for (const count of [35, 35, 30]) {
      const page = await query.list(resolvedContext(actor), { cursor });
      expect(page.totalCount).toBe(100);
      expect(page.items).toHaveLength(count);
      ids.push(...page.items.map((item) => item.itemId));
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(ids).size).toBe(100);
    expect(await readSideEffectCounts(client)).toEqual(before);
  });

  it("releases the next available batch immediately and replays without duplicate publication", async () => {
    const releases = createRecommendationUserReleaseRepository(pool as unknown as BacklinkTenantPool);
    const scope = { organizationId, workspaceId, websiteProjectId, actorId: "no-gate-actor" };
    expect(await releases.publishInitial(scope)).toMatchObject({ state: "PUBLISHED", currentBatchOrdinal: 1 });
    const command = { ...scope, idempotencyKey: "no-gate-next", requestHash: "no-gate-next-hash" };
    expect(await releases.getMore(command)).toMatchObject({
      state: "RELEASED", currentBatchOrdinal: 1, releasedBatchOrdinal: 2, replayed: false,
    });
    expect(await releases.getMore(command)).toMatchObject({
      state: "RELEASED", currentBatchOrdinal: 1, releasedBatchOrdinal: 2, replayed: true,
    });
    const stored = await client.query(
      `SELECT reason, required_opportunity_count, successful_opportunity_count
         FROM backlink_recommendation_user_unlocks WHERE user_id=$1`,
      [scope.actorId],
    );
    expect(stored.rows).toEqual([{
      reason: "NO_GATE", required_opportunity_count: 0, successful_opportunity_count: 0,
    }]);
    expect(await releases.getStatus(scope)).toMatchObject({ currentBatchOrdinal: 2 });
  });

  it("returns the actor-entitled released history with NULL metrics preserved", async () => {
    const actorAResult = await query.list(resolvedContext(actorA), {
      sort: "domain_asc",
      limit: 100,
    });
    expect(actorAResult.totalCount).toBe(4);
    expect(actorAResult.items.map(({ domain }) => domain)).toEqual([
      "alpha.test",
      "beta.test",
      "gamma.test",
      "stale.test",
    ]);
    expect(actorAResult.releasedPool).toMatchObject({
      generationCount: 2,
      oldestVisiblePoolGeneration: 1,
      newestVisiblePoolGeneration: 2,
    });
    expect(actorAResult.items[1]?.metrics).toEqual({
      targetMarketOrganicTraffic: null,
      dataForSeoRank: 50,
      spamScore: null,
      ahrefsDr: null,
      libraryMonthlyTraffic: null,
    });
    expect(actorAResult.items[0]).not.toHaveProperty("internalScore");
    expect(actorAResult.items[0]).not.toHaveProperty("providerTaskId");
    expect(actorAResult.items[0]).not.toHaveProperty("generationContractId");
    expect(
      Object.fromEntries(
        actorAResult.items.map(({ domain, releasedAt }) => [
          domain,
          releasedAt,
        ]),
      ),
    ).toEqual({
      "alpha.test": actorABatchOneReleasedAt,
      "beta.test": actorABatchOneReleasedAt,
      "gamma.test": actorABatchTwoReleasedAt,
      "stale.test": actorAStaleBatchReleasedAt,
    });
    expect(actorABatchOneReleasedAt).not.toBe("2026-08-31T01:00:00.000Z");
    expect(actorABatchTwoReleasedAt).not.toBe("2026-08-31T02:00:00.000Z");
    expect(actorAStaleBatchReleasedAt).not.toBe("2026-08-30T01:00:00.000Z");

    const actorBResult = await query.list(resolvedContext(actorB), {
      sort: "domain_asc",
      limit: 100,
    });
    expect(actorBResult.items.map(({ domain }) => domain)).toEqual([
      "archived.test",
      "gamma.test",
    ]);
    expect(actorBResult.items.map(({ releasedAt }) => releasedAt)).toEqual([
      actorBBatchTwoReleasedAt,
      actorBBatchTwoReleasedAt,
    ]);
    expect(actorBResult.releasedPool).toMatchObject({
      generationCount: 1,
      oldestVisiblePoolGeneration: 2,
      newestVisiblePoolGeneration: 2,
    });
    expect(actorBBatchTwoReleasedAt).not.toBe(actorABatchTwoReleasedAt);
    expect(
      await query.list(resolvedContext(actorWithoutPublication), {
        limit: 100,
      }),
    ).toMatchObject({
      items: [],
      releasedPool: {
        generationCount: 0,
        oldestVisiblePoolGeneration: null,
        newestVisiblePoolGeneration: null,
      },
      totalCount: 0,
      nextCursor: null,
    });

    for (const context of [
      resolvedContext(actorA, { organizationId: otherOrganizationId }),
      resolvedContext(actorA, {
        workspaceId: otherWorkspaceId,
        websiteProjectId: otherProjectId,
      }),
    ]) {
      await expect(query.list(context, { limit: 100 })).rejects.toBeInstanceOf(
        BacklinkError,
      );
    }
  });

  it("filters real batches while keeping all entitled options on empty pages", async () => {
    const all = await query.list(resolvedContext(actorA), { limit: 100 });
    const options = all.releasedPool.filterOptions;
    expect(options?.batches.map((batch) => batch.batchId).sort()).toEqual(
      [currentBatchOneId, currentBatchTwoId, staleBatchId].sort(),
    );
    for (const batch of options?.batches ?? []) {
      const result = await query.list(resolvedContext(actorA), {
        batchId: batch.batchId, limit: 100,
      });
      expect(result.totalCount).toBe(batch.count);
      expect(result.releasedPool.filterOptions).toEqual(options);
      const exported = await repository.exportItems({
        organizationId, workspaceId, websiteProjectId, actorId: actorA,
        filters: normalizeRecommendationFeedFilters({ batchId: batch.batchId }),
        selectedItemIds: [],
      });
      expect(exported.map((item) => item.itemId).sort()).toEqual(
        result.items.map((item) => item.itemId).sort(),
      );
    }
    const empty = await query.list(resolvedContext(actorA), {
      batchId: unpublishedBatchId,
    });
    expect(empty.totalCount).toBe(0);
    expect(empty.releasedPool.filterOptions).toEqual(options);
    const otherActor = await query.list(resolvedContext(actorB), {
      batchId: currentBatchOneId,
    });
    expect(otherActor.items).toEqual([]);
    expect(otherActor.releasedPool.filterOptions?.batches.map((batch) => batch.batchId))
      .toEqual([currentBatchTwoId]);
    const first = await query.list(resolvedContext(actorA), {
      batchId: currentBatchOneId, limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    await expect(query.list(resolvedContext(actorA), {
      batchId: currentBatchTwoId, limit: 1, cursor: first.nextCursor as string,
    })).rejects.toBeInstanceOf(BacklinkError);
  });

  it("applies DB filters, stable cursors, cursor scope, and escaped domain search", async () => {
    const latest = await query.list(resolvedContext(actorA), {
      sort: "released_desc",
      limit: 1,
    });
    expect(
      latest.items.map(({ domain, releasedAt }) => [domain, releasedAt]),
    ).toEqual([["stale.test", actorAStaleBatchReleasedAt]]);
    expect(latest.nextCursor).toEqual(expect.any(String));
    const nextReleased = await query.list(resolvedContext(actorA), {
      sort: "released_desc",
      limit: 1,
      cursor: latest.nextCursor as string,
    });
    expect(
      nextReleased.items.map(({ domain, releasedAt }) => [domain, releasedAt]),
    ).toEqual([["gamma.test", actorABatchTwoReleasedAt]]);

    const first = await query.list(resolvedContext(actorA), {
      trafficMin: 0,
      sort: "traffic_desc",
      limit: 1,
    });
    expect(first.totalCount).toBe(3);
    expect(first.items.map(({ domain }) => domain)).toEqual(["stale.test"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await query.list(resolvedContext(actorA), {
      trafficMin: 0,
      sort: "traffic_desc",
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(second.totalCount).toBe(3);
    expect(second.items.map(({ domain }) => domain)).toEqual(["alpha.test"]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const third = await query.list(resolvedContext(actorA), {
      trafficMin: 0,
      sort: "traffic_desc",
      limit: 1,
      cursor: second.nextCursor as string,
    });
    expect(third.totalCount).toBe(3);
    expect(third.items.map(({ domain }) => domain)).toEqual(["gamma.test"]);
    expect(third.nextCursor).toBeNull();

    await expect(
      query.list(resolvedContext(actorB), {
        trafficMin: 0,
        sort: "traffic_desc",
        limit: 1,
        cursor: first.nextCursor as string,
      }),
    ).rejects.toBeInstanceOf(BacklinkError);
    await expect(
      query.list(resolvedContext(actorA), {
        category: "editorial",
        trafficMin: 0,
        sort: "traffic_desc",
        limit: 1,
        cursor: first.nextCursor as string,
      }),
    ).rejects.toBeInstanceOf(BacklinkError);
    const [cursorPayload, cursorSignature] = (first.nextCursor as string).split(
      ".",
    );
    const tamperedCursor = `${cursorPayload}.${cursorSignature?.startsWith("A") ? "B" : "A"}${cursorSignature?.slice(1)}`;
    await expect(
      query.list(resolvedContext(actorA), {
        trafficMin: 0,
        sort: "traffic_desc",
        limit: 1,
        cursor: tamperedCursor,
      }),
    ).rejects.toBeInstanceOf(BacklinkError);

    for (const domainSearch of ["%", "_", "\\"]) {
      const escaped = await query.list(resolvedContext(actorA), {
        domainSearch,
        limit: 100,
      });
      expect(escaped.items).toEqual([]);
    }
    const normalized = await query.list(resolvedContext(actorA), {
      domainSearch: " ALPHA ",
      limit: 100,
    });
    expect(normalized.items.map(({ domain }) => domain)).toEqual([
      "alpha.test",
    ]);

    await expect(
      repository.list({
        organizationId,
        workspaceId,
        websiteProjectId,
        actorId: actorA,
        filters: normalizeRecommendationFeedFilters({ limit: 1 }),
        cursor: {
          binding: {
            recommendationContextVersionId: staleLineage.contextId,
            visiblePoolGeneration: staleLineage.visiblePoolGeneration,
            generationContractId: staleLineage.generationId,
            inputPinId: staleLineage.inputPinId,
          },
          position: {
            itemId: alphaItemId,
            releasedAt: "2026-08-31T01:00:00.000Z",
            canonicalDomain: "alpha.test",
            trafficOrganicEtv: 100,
            authorityRank: 50,
            spamScore: 3,
          },
        },
      }),
    ).rejects.toBeInstanceOf(BacklinkError);
  });

  it("keeps selected and filtered exports inside entitlement with zero write/provider deltas", async () => {
    const before = await readSideEffectCounts(client);
    const selected = await query.export(resolvedContext(actorA), {
      selectedItemIds: [alphaItemId, gammaItemId],
      sort: "domain_asc",
    });
    expect(selected.content).toContain('"alpha.test"');
    expect(selected.content).toContain('"gamma.test"');
    expect(selected.content).not.toContain("hidden.test");
    await expect(
      query.export(resolvedContext(actorA), {
        selectedItemIds: [unpublishedItemId],
      }),
    ).rejects.toBeInstanceOf(BacklinkError);

    const filtered = await query.export(resolvedContext(actorA), {
      category: "editorial",
      recommendedOnly: true,
      sort: "domain_asc",
    });
    expect(filtered.content).toContain('"alpha.test"');
    expect(filtered.content).toContain('"gamma.test"');
    expect(filtered.content).not.toContain("beta.test");
    expect(filtered.content).not.toContain("archived.test");
    expect(filtered.content).not.toContain("preparing.test");
    expect(filtered.content).toContain('"stale.test"');

    await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        index % 2 === 0
          ? query.list(resolvedContext(actorA), {
              sort: "domain_asc",
              limit: 2,
            })
          : query.export(resolvedContext(actorA), {
              domainSearch: "test",
              sort: "domain_asc",
            }),
      ),
    );
    expect(await readSideEffectCounts(client)).toEqual(before);
  });
});
