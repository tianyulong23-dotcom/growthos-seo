import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type DeploymentManifest = Readonly<{
  heads: Readonly<{ backlinks: string }>;
  steps: readonly Readonly<{
    migrationId: string;
    path: string;
    sha256: string;
  }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );

const organizationId = "97000000-0000-4000-8000-000000000001";
const workspaceId = "97000000-0000-4000-8000-000000000002";
const websiteProjectId = "97000000-0000-4000-8000-000000000003";
const otherProjectId = "97000000-0000-4000-8000-000000000004";
const otherOrganizationId = "97000000-0000-4000-8000-000000000005";
const otherWorkspaceId = "97000000-0000-4000-8000-000000000006";
const outreachProfileId = "97000000-0000-4000-8000-000000000010";
const inputPinId = "97000000-0000-4000-8000-000000000011";
const generationId = "97000000-0000-4000-8000-000000000012";
const contextId = "97000000-0000-4000-8000-000000000013";
const seedId = "97000000-0000-4000-8000-000000000014";
const unknownGenerationId = "97000000-0000-4000-8000-000000000015";
const unknownContextId = "97000000-0000-4000-8000-000000000016";
const unknownSeedId = "97000000-0000-4000-8000-000000000017";
const budgetGenerationId = "97000000-0000-4000-8000-000000000018";
const budgetContextId = "97000000-0000-4000-8000-000000000019";
const budgetSeedId = "97000000-0000-4000-8000-000000000020";
const aggregateBudgetGenerationId = "97000000-0000-4000-8000-000000000021";
const aggregateBudgetContextId = "97000000-0000-4000-8000-000000000022";
const aggregateBudgetSeedId = "97000000-0000-4000-8000-000000000023";
const safeSupplyGenerationId = "97000000-0000-4000-8000-000000000024";
const safeSupplyContextId = "97000000-0000-4000-8000-000000000025";
const safeSupplySeedId = "97000000-0000-4000-8000-000000000026";
const lowYieldGenerationId = "97000000-0000-4000-8000-000000000027";
const lowYieldContextId = "97000000-0000-4000-8000-000000000028";
const lowYieldSeedId = "97000000-0000-4000-8000-000000000029";
const validLowYieldGenerationId = "97000000-0000-4000-8000-000000000030";
const validLowYieldContextId = "97000000-0000-4000-8000-000000000031";
const validLowYieldSeedId = "97000000-0000-4000-8000-000000000032";
const seedFingerprint = "schema-discovery-seed-v1";
const unknownSeedFingerprint = "schema-unknown-seed-v1";
const budgetSeedFingerprint = "schema-budget-seed-v1";
const aggregateBudgetSeedFingerprint = "schema-aggregate-budget-seed-v1";
const safeSupplySeedFingerprint = "schema-safe-supply-seed-v1";
const lowYieldSeedFingerprint = "schema-low-yield-seed-v1";
const validLowYieldSeedFingerprint = "schema-valid-low-yield-seed-v1";
const policyVersion = "recommendation-discovery-budget.v1";
const inputFingerprint = "schema-discovery-input-pin-v1";
const hash = (character: string) => character.repeat(64);

const intentTable = "backlink_recommendation_discovery_request_intents";
const outcomeTable = "backlink_recommendation_discovery_request_outcomes";
const windowTable = "backlink_recommendation_discovery_window_facts";
const roundTable = "backlink_recommendation_discovery_round_facts";
const terminalTable =
  "backlink_recommendation_discovery_generation_terminal_facts";

describe("recommendation pool V2 discovery ledger schema", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let relationBefore0080: unknown;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(rolesUrl, "utf8"));
    await client.query(`
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
    `);

    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    const migrationSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const manifestHeadStep = migrationSteps.at(-1);
    expect(manifestHeadStep).toBeDefined();
    expect(manifest.heads.backlinks).toBe(
      manifestHeadStep?.migrationId.replace(/^backlinks-/, ""),
    );
    const migration0080 = migrationSteps.find(
      ({ migrationId }) => migrationId === "backlinks-0080",
    );
    expect(migration0080?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const migration0080Index = migrationSteps.findIndex(
      ({ migrationId }) => migrationId === "backlinks-0080",
    );
    expect(migration0080Index).toBeGreaterThanOrEqual(0);
    for (const step of migrationSteps.slice(0, migration0080Index)) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    relationBefore0080 = (
      await client.query(
        `SELECT to_regclass('backlinks.${intentTable}') AS relation`,
      )
    ).rows[0]?.relation;
    await client.query(
      await readFile(migrationUrl(migration0080?.path ?? ""), "utf8"),
    );
    await insertProjectInputs();
    await insertGeneration(generationId, contextId, 1);
    await insertSeed(generationId, contextId, seedId, seedFingerprint, 1);
    await insertGeneration(unknownGenerationId, unknownContextId, 2);
    await insertSeed(
      unknownGenerationId,
      unknownContextId,
      unknownSeedId,
      unknownSeedFingerprint,
      2,
    );
    await insertGeneration(budgetGenerationId, budgetContextId, 3);
    await insertSeed(
      budgetGenerationId,
      budgetContextId,
      budgetSeedId,
      budgetSeedFingerprint,
      3,
    );
    await insertGeneration(
      aggregateBudgetGenerationId,
      aggregateBudgetContextId,
      4,
    );
    await insertSeed(
      aggregateBudgetGenerationId,
      aggregateBudgetContextId,
      aggregateBudgetSeedId,
      aggregateBudgetSeedFingerprint,
      4,
    );
    await insertGeneration(safeSupplyGenerationId, safeSupplyContextId, 5);
    await insertSeed(
      safeSupplyGenerationId,
      safeSupplyContextId,
      safeSupplySeedId,
      safeSupplySeedFingerprint,
      5,
    );
    await insertGeneration(lowYieldGenerationId, lowYieldContextId, 6);
    await insertSeed(
      lowYieldGenerationId,
      lowYieldContextId,
      lowYieldSeedId,
      lowYieldSeedFingerprint,
      6,
    );
    await insertGeneration(
      validLowYieldGenerationId,
      validLowYieldContextId,
      7,
    );
    await insertSeed(
      validLowYieldGenerationId,
      validLowYieldContextId,
      validLowYieldSeedId,
      validLowYieldSeedFingerprint,
      7,
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  async function insertProjectInputs(): Promise<void> {
    await client.query(
      `INSERT INTO backlinks.backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, 'profile-v1', 'target-v1',
         '["topic"]'::jsonb, '["product"]'::jsonb, '[]'::jsonb,
         '["audience"]'::jsonb, '["editorial review"]'::jsonb,
         'US', 'United States', 'en', '["dataforseo"]'::jsonb,
         'schema-discovery-profile-v1', 'phase3-schema-test'
       )`,
      [outreachProfileId, organizationId, workspaceId, websiteProjectId],
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
         $1, $2, $3, $4, 9, 'site-profile-v1', $5, 'target-v1',
         '[]'::jsonb, '[]'::jsonb, 'US',
         'recommendation-qualification.v1', $6, 'phase3-schema-test'
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        websiteProjectId,
        outreachProfileId,
        inputFingerprint,
      ],
    );
  }

  async function insertGeneration(
    generationContractId: string,
    recommendationContextId: string,
    visiblePoolGeneration: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
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
         'recommendation-qualification.v1',
         'recommendation-visibility.v1',
         'recommendation-commercial-fit.v4', 'TARGET_MARKET',
         'US', 'United States', 'en', 2840, 'en', '{}'::jsonb,
         'recommendation-qualification.v1', 'phase3-schema-test',
         'recommendation-pool.v2', 'recommendation-seed.v2',
         'recommendation-release.v2', 'recommendation-marker.v2', $8
       )`,
      [
        generationContractId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextId,
        visiblePoolGeneration,
        inputPinId,
        policyVersion,
      ],
    );
  }

  async function insertSeed(
    generationContractId: string,
    recommendationContextId: string,
    commercialSeedId: string,
    commercialSeedFingerprint: string,
    visiblePoolGeneration: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, seed_kind, raw_value,
         normalized_value, source, validation_status, confidence_band,
         seed_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'KEYWORD', 'Technical SEO',
         $9, 'USER_INPUT', 'VERIFIED', 'HIGH', $10, 'phase3-schema-test'
       )`,
      [
        commercialSeedId,
        organizationId,
        workspaceId,
        websiteProjectId,
        generationContractId,
        recommendationContextId,
        visiblePoolGeneration,
        inputPinId,
        `technical seo ${visiblePoolGeneration}`,
        commercialSeedFingerprint,
      ],
    );
  }

  async function insertIntent(input: {
    id: string;
    generationContractId?: string;
    recommendationContextId?: string;
    visiblePoolGeneration?: number;
    commercialSeedId?: string;
    commercialSeedFingerprint?: string;
    round: 1 | 2;
    windowOrdinal?: number;
    requestFingerprint: string;
    pathFingerprint: string;
    idempotencyKey: string;
    idempotencyHash: string;
    authorizedCostMicros?: number;
    organization?: string;
    workspace?: string;
    websiteProject?: string;
    dbClient?: Client;
  }): Promise<QueryResult> {
    return (input.dbClient ?? client).query(
      `INSERT INTO backlinks.${intentTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         seed_id, seed_fingerprint, seed_kind, seed_source,
         discovery_budget_policy_version, round_number,
         discovery_window_ordinal, discovery_source, request_type, page_type,
         page_ordinal,
         canonical_request_fingerprint, canonical_path_fingerprint,
         country_code, language_code, business_direction_fingerprint,
         authorized_cost_micros, idempotency_key, idempotency_hash,
         started_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'recommendation-pool.v2',
         $9, $10, 'KEYWORD', 'USER_INPUT', $11, $12, $13, 'dataforseo',
         'SERP_BACKLINKS', 'RESULT_PAGE', 0, $14, $15, 'US', 'en', $16,
         $17, $18, $19, statement_timestamp(), 'phase3-schema-test'
       )
       RETURNING id`,
      [
        input.id,
        input.organization ?? organizationId,
        input.workspace ?? workspaceId,
        input.websiteProject ?? websiteProjectId,
        input.generationContractId ?? generationId,
        input.recommendationContextId ?? contextId,
        input.visiblePoolGeneration ?? 1,
        inputPinId,
        input.commercialSeedId ?? seedId,
        input.commercialSeedFingerprint ?? seedFingerprint,
        policyVersion,
        input.round,
        input.windowOrdinal ?? 1,
        input.requestFingerprint,
        input.pathFingerprint,
        inputFingerprint,
        input.authorizedCostMicros ?? 500_000,
        input.idempotencyKey,
        input.idempotencyHash,
      ],
    );
  }

  async function insertProviderLineage(input: {
    ordinal: number;
    chargeState: "SETTLED" | "UNKNOWN_CHARGE";
    actualCostMicros?: number;
  }): Promise<{
    providerRequestId: string;
    providerBatchRequestId: string;
    providerUsageLedgerId: string;
    providerTaskId: string;
  }> {
    const suffix = input.ordinal.toString().padStart(12, "0");
    const providerRequestId = `97000000-0000-4000-8100-${suffix}`;
    const providerBatchRequestId = `97000000-0000-4000-8200-${suffix}`;
    const providerUsageLedgerId = `97000000-0000-4000-8300-${suffix}`;
    const budgetId = `97000000-0000-4000-8400-${suffix}`;
    const providerTaskId = `provider-task-${input.ordinal}`;
    const periodStart = `2026-08-${input.ordinal.toString().padStart(2, "0")}T00:00:00Z`;
    const periodEnd = `2026-08-${(input.ordinal + 1)
      .toString()
      .padStart(2, "0")}T00:00:00Z`;
    const unknown = input.chargeState === "UNKNOWN_CHARGE";
    const actualCostMicros = input.actualCostMicros ?? 500_000;

    await client.query(
      `INSERT INTO backlinks.backlink_provider_requests (
         id, organization_id, workspace_id, website_project_id,
         provider, endpoint, request_fingerprint, active_request_bucket,
         request_schema_version, request_payload, status, started_at,
         finished_at, created_by
       ) VALUES (
         $1, $2, $3, $4, 'dataforseo', 'fixture/discovery', $5,
         $6, 1, '{}'::jsonb, $7, statement_timestamp(),
         statement_timestamp(), 'phase3-schema-test'
       )`,
      [
        providerRequestId,
        organizationId,
        workspaceId,
        websiteProjectId,
        hash(String((input.ordinal % 8) + 1)),
        `phase3-${input.ordinal}`,
        unknown ? "unknown_charge" : "succeeded",
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_provider_budgets (
         id, organization_id, workspace_id, provider, period_start, period_end,
         limit_micros, spent_micros, reserved_micros, created_by
        ) VALUES (
          $1, $2, $3, 'dataforseo', $4, $5, 2000000, 0, $6,
          'phase3-schema-test'
        )`,
      [
        budgetId,
        organizationId,
        workspaceId,
        periodStart,
        periodEnd,
        unknown ? 500_000 : 0,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_provider_usage_ledger (
         id, organization_id, workspace_id, website_project_id, budget_id,
         provider_request_id, provider, reservation_key,
         estimated_cost_micros, actual_cost_micros, status, settled_at,
         created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'dataforseo', $7, $8, $9, $10, $11,
          'phase3-schema-test'
        )`,
      [
        providerUsageLedgerId,
        organizationId,
        workspaceId,
        websiteProjectId,
        budgetId,
        providerRequestId,
        `phase3-reservation-${input.ordinal}`,
        unknown ? 500_000 : actualCostMicros,
        unknown ? null : actualCostMicros,
        unknown ? "reserved" : "settled",
        unknown ? null : new Date("2026-08-29T00:01:00Z"),
      ],
    );
    await client.query(
      `INSERT INTO backlinks.provider_batch_requests (
         id, organization_id, workspace_id, website_project_id,
         provider, endpoint, request_intent, refresh_mode, location_code,
         language_code, request_schema_version, response_schema_version,
         normalized_request_hash, request_count, succeeded_count,
         estimated_cost_micros, actual_cost_micros, provider_task_id,
         result_summary, status, failure_code, started_at, finished_at,
         request_id, budget_reservation_id, created_by
        ) VALUES (
          $1, $2, $3, $4, 'dataforseo', 'fixture/discovery', 'DISCOVERY',
          'FORCE_LIVE', '2840', 'en', 1, 'fixture.v1', $5, 1, $6, $7,
          $8, $9, '[]'::jsonb, $10, $11, statement_timestamp(),
          statement_timestamp(), $12, $13, 'phase3-schema-test'
        )`,
      [
        providerBatchRequestId,
        organizationId,
        workspaceId,
        websiteProjectId,
        hash(String((input.ordinal % 8) + 1)),
        unknown ? 0 : 1,
        unknown ? 500_000 : actualCostMicros,
        unknown ? null : actualCostMicros,
        providerTaskId,
        unknown ? "unknown_charge" : "succeeded",
        unknown ? "UNKNOWN_CHARGE" : null,
        `provider-request-${input.ordinal}`,
        `phase3-reservation-${input.ordinal}`,
      ],
    );

    return {
      providerRequestId,
      providerBatchRequestId,
      providerUsageLedgerId,
      providerTaskId,
    };
  }

  async function insertOutcome(input: {
    id: string;
    requestIntentId: string;
    generationContractId?: string;
    recommendationContextId?: string;
    visiblePoolGeneration?: number;
    providerRequestId: string;
    providerBatchRequestId: string;
    providerUsageLedgerId: string;
    providerTaskId: string;
    rawCount: number;
    effectiveCount: number;
    newCount: number;
    duplicateCount: number;
    actualCostMicros: number | null;
    cumulativeCostMicros: number | null;
    status?: "SUCCEEDED" | "UNKNOWN_CHARGE";
    chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
  }): Promise<QueryResult> {
    const status = input.status ?? "SUCCEEDED";
    return client.query(
      `INSERT INTO backlinks.${outcomeTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         request_intent_id, provider_request_id, provider_batch_request_id,
         provider_usage_ledger_id, provider_task_id, raw_candidate_count,
         effective_candidate_count, new_unique_count, duplicate_count,
         actual_cost_micros, cumulative_cost_micros, status, charge_state,
         failure_code, finished_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'recommendation-pool.v2',
         $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, statement_timestamp(), 'phase3-schema-test'
       )
       RETURNING id`,
      [
        input.id,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.generationContractId ?? generationId,
        input.recommendationContextId ?? contextId,
        input.visiblePoolGeneration ?? 1,
        inputPinId,
        input.requestIntentId,
        input.providerRequestId,
        input.providerBatchRequestId,
        input.providerUsageLedgerId,
        input.providerTaskId,
        input.rawCount,
        input.effectiveCount,
        input.newCount,
        input.duplicateCount,
        input.actualCostMicros,
        input.cumulativeCostMicros,
        status,
        input.chargeState ?? "SETTLED",
        status === "UNKNOWN_CHARGE" ? "UNKNOWN_CHARGE" : null,
      ],
    );
  }

  async function insertWindowFact(input: {
    id: string;
    generationContractId: string;
    recommendationContextId: string;
    visiblePoolGeneration: number;
    round: 1 | 2;
    windowOrdinal: number;
    completedRequestCount: number;
    rawCount: number;
    effectiveCount: number;
    newCount: number;
    duplicateCount: number;
    authorizedCostMicros: number;
    settledCostMicros: number | null;
    chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
    requestSetFingerprint: string;
  }): Promise<QueryResult> {
    return client.query(
      `INSERT INTO backlinks.${windowTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, round_number, window_ordinal,
         completed_request_count, raw_candidate_count,
         effective_candidate_count, new_unique_count, duplicate_count,
         new_unique_rate_numerator, new_unique_rate_denominator,
         window_authorized_cost_micros, window_settled_cost_micros,
         charge_state, canonical_request_set_fingerprint,
         completed_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'recommendation-pool.v2',
         $9, $10, $11, $12, $13, $14, $15, $16, $15, $14, $17, $18,
         $19, $20, statement_timestamp(), 'phase3-schema-test'
       )
       RETURNING id`,
      [
        input.id,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.generationContractId,
        input.recommendationContextId,
        input.visiblePoolGeneration,
        inputPinId,
        policyVersion,
        input.round,
        input.windowOrdinal,
        input.completedRequestCount,
        input.rawCount,
        input.effectiveCount,
        input.newCount,
        input.duplicateCount,
        input.authorizedCostMicros,
        input.settledCostMicros,
        input.chargeState ?? "SETTLED",
        input.requestSetFingerprint,
      ],
    );
  }

  async function insertRoundFact(input: {
    id: string;
    generationContractId: string;
    recommendationContextId: string;
    visiblePoolGeneration: number;
    round: 1 | 2;
    completedWindowCount: number;
    completedRequestCount: number;
    rawCount: number;
    effectiveCount: number;
    newCount: number;
    duplicateCount: number;
    authorizedCostMicros: number;
    settledCostMicros: number | null;
    cumulativeCostMicros: number | null;
    chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
    pathsExhausted: boolean;
    changedDimensions?: readonly string[];
    requestSetFingerprint: string;
    policyDecision: "START_ROUND_2" | "STOP";
    terminalReason: string | null;
  }): Promise<QueryResult> {
    return client.query(
      `INSERT INTO backlinks.${roundTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, round_number,
         completed_window_count, completed_request_count,
         raw_candidate_count, effective_candidate_count, new_unique_count,
         duplicate_count, new_unique_rate_numerator,
         new_unique_rate_denominator, round_authorized_cost_micros,
         round_settled_cost_micros, cumulative_settled_cost_micros,
         charge_state, paths_exhausted, changed_dimensions,
         canonical_request_set_fingerprint, policy_decision, terminal_reason,
         completed_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'recommendation-pool.v2',
         $9, $10, $11, $12, $13, $14, $15, $16, $15, $14, $17, $18, $19,
         $20, $21, $22, $23, $24, $25, statement_timestamp(),
         'phase3-schema-test'
       )
       RETURNING id`,
      [
        input.id,
        organizationId,
        workspaceId,
        websiteProjectId,
        input.generationContractId,
        input.recommendationContextId,
        input.visiblePoolGeneration,
        inputPinId,
        policyVersion,
        input.round,
        input.completedWindowCount,
        input.completedRequestCount,
        input.rawCount,
        input.effectiveCount,
        input.newCount,
        input.duplicateCount,
        input.authorizedCostMicros,
        input.settledCostMicros,
        input.cumulativeCostMicros,
        input.chargeState ?? "SETTLED",
        input.pathsExhausted,
        input.changedDimensions ?? [],
        input.requestSetFingerprint,
        input.policyDecision,
        input.terminalReason,
      ],
    );
  }

  it("applies a fresh chain through 0080 and adds forced-RLS facts at the 0079 boundary", async () => {
    expect(relationBefore0080).toBeNull();
    const names = [
      intentTable,
      outcomeTable,
      windowTable,
      roundTable,
      terminalTable,
    ];
    expect(
      (
        await client.query(
          `SELECT relname, relrowsecurity, relforcerowsecurity
             FROM pg_class
            WHERE relnamespace='backlinks'::regnamespace
              AND relname=ANY($1::text[])
            ORDER BY relname`,
          [names],
        )
      ).rows,
    ).toEqual(
      [...names].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
    for (const table of names) {
      expect(
        (
          await client.query(
            `SELECT
               has_table_privilege(
                 'growthos_backlinks_writer', $1, 'SELECT'
               ) AS "writerSelect",
               has_table_privilege(
                 'growthos_backlinks_writer', $1, 'INSERT'
               ) AS "writerInsert",
               has_table_privilege(
                 'growthos_backlinks_writer', $1, 'UPDATE'
               ) AS "writerUpdate",
               has_table_privilege(
                 'growthos_backlinks_writer', $1, 'DELETE'
               ) AS "writerDelete",
               has_table_privilege(
                 'growthos_reporting_reader', $1, 'SELECT'
               ) AS "reportingSelect",
               has_table_privilege(
                 'growthos_reporting_reader', $1, 'INSERT'
               ) AS "reportingInsert"`,
            [`backlinks.${table}`],
          )
        ).rows,
      ).toEqual([
        {
          writerSelect: true,
          writerInsert: true,
          writerUpdate: false,
          writerDelete: false,
          reportingSelect: true,
          reportingInsert: false,
        },
      ]);
    }
  });

  it("enforces generation and seed scope while concurrent idempotent intents create one row", async () => {
    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000100",
        round: 1,
        requestFingerprint: hash("0"),
        pathFingerprint: hash("1"),
        idempotencyKey: "organization-mismatch",
        idempotencyHash: hash("2"),
        organization: otherOrganizationId,
      }),
    ).rejects.toThrow(/not found|foreign key/i);
    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000104",
        round: 1,
        requestFingerprint: hash("3"),
        pathFingerprint: hash("4"),
        idempotencyKey: "workspace-mismatch",
        idempotencyHash: hash("5"),
        workspace: otherWorkspaceId,
      }),
    ).rejects.toThrow(/not found|foreign key/i);
    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000101",
        round: 1,
        requestFingerprint: hash("6"),
        pathFingerprint: hash("7"),
        idempotencyKey: "scope-mismatch",
        idempotencyHash: hash("8"),
        websiteProject: otherProjectId,
      }),
    ).rejects.toThrow(/not found|foreign key/i);
    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000105",
        commercialSeedId: unknownSeedId,
        commercialSeedFingerprint: unknownSeedFingerprint,
        round: 1,
        requestFingerprint: hash("9"),
        pathFingerprint: hash("a"),
        idempotencyKey: "seed-generation-mismatch",
        idempotencyHash: hash("b"),
      }),
    ).rejects.toThrow(/not found|foreign key/i);

    const firstClient = new PgClient({
      connectionString: harness.connectionString,
    });
    const secondClient = new PgClient({
      connectionString: harness.connectionString,
    });
    await firstClient.connect();
    await secondClient.connect();
    const sql = `INSERT INTO backlinks.${intentTable} (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       visible_pool_generation, input_pin_id, pool_contract_version,
       seed_id, seed_fingerprint, seed_kind, seed_source,
       discovery_budget_policy_version, round_number,
       discovery_window_ordinal, discovery_source, request_type, page_type,
       page_ordinal,
       canonical_request_fingerprint, canonical_path_fingerprint,
       country_code, language_code, business_direction_fingerprint,
       authorized_cost_micros, idempotency_key, idempotency_hash,
       started_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 1, $7, 'recommendation-pool.v2',
       $8, $9, 'KEYWORD', 'USER_INPUT', $10, 1, 1, 'dataforseo',
       'SERP_BACKLINKS', 'RESULT_PAGE', 0, $11, $12, 'US', 'en', $13,
       1000000, 'concurrent-request', $14, statement_timestamp(),
       'phase3-schema-test'
     )
     ON CONFLICT DO NOTHING
     RETURNING id`;
    const values = [
      "97000000-0000-4000-8000-000000000102",
      organizationId,
      workspaceId,
      websiteProjectId,
      generationId,
      contextId,
      inputPinId,
      seedId,
      seedFingerprint,
      policyVersion,
      hash("d"),
      hash("e"),
      inputFingerprint,
      hash("f"),
    ];
    const secondValues = [...values];
    secondValues[0] = "97000000-0000-4000-8000-000000000103";
    const results = await Promise.all([
      firstClient.query(sql, values),
      secondClient.query(sql, secondValues),
    ]);
    await firstClient.end();
    await secondClient.end();
    expect(results.map(({ rows }) => rows.length).sort()).toEqual([0, 1]);
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.${intentTable}
            WHERE idempotency_key='concurrent-request'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  }, 30_000);

  it("serializes concurrent intent authorization before the round budget can exceed one dollar", async () => {
    const firstClient = new PgClient({
      connectionString: harness.connectionString,
    });
    const secondClient = new PgClient({
      connectionString: harness.connectionString,
    });
    await firstClient.connect();
    await secondClient.connect();
    let results: PromiseSettledResult<QueryResult>[];
    try {
      results = await Promise.allSettled([
        insertIntent({
          id: "97000000-0000-4000-8000-000000000106",
          generationContractId: aggregateBudgetGenerationId,
          recommendationContextId: aggregateBudgetContextId,
          visiblePoolGeneration: 4,
          commercialSeedId: aggregateBudgetSeedId,
          commercialSeedFingerprint: aggregateBudgetSeedFingerprint,
          round: 1,
          requestFingerprint: hash("c"),
          pathFingerprint: hash("d"),
          idempotencyKey: "aggregate-budget-first",
          idempotencyHash: hash("e"),
          authorizedCostMicros: 600_000,
          dbClient: firstClient,
        }),
        insertIntent({
          id: "97000000-0000-4000-8000-000000000107",
          generationContractId: aggregateBudgetGenerationId,
          recommendationContextId: aggregateBudgetContextId,
          visiblePoolGeneration: 4,
          commercialSeedId: aggregateBudgetSeedId,
          commercialSeedFingerprint: aggregateBudgetSeedFingerprint,
          round: 1,
          requestFingerprint: hash("f"),
          pathFingerprint: hash("0"),
          idempotencyKey: "aggregate-budget-second",
          idempotencyHash: hash("1"),
          authorizedCostMicros: 600_000,
          dbClient: secondClient,
        }),
      ]);
    } finally {
      await firstClient.end();
      await secondClient.end();
    }
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count,
                  sum(authorized_cost_micros)::integer AS "authorizedCost"
             FROM backlinks.${intentTable}
            WHERE generation_contract_id=$1 AND round_number=1`,
          [aggregateBudgetGenerationId],
        )
      ).rows,
    ).toEqual([{ count: 1, authorizedCost: 600_000 }]);
  }, 30_000);

  it("keeps distinct Provider identities and permits only one outcome per request", async () => {
    const lineage = await insertProviderLineage({
      ordinal: 1,
      chargeState: "SETTLED",
      actualCostMicros: 1_000_000,
    });
    expect(new Set(Object.values(lineage)).size).toBe(4);
    const requestIntentId = (
      await client.query(
        `SELECT id
           FROM backlinks.${intentTable}
          WHERE idempotency_key='concurrent-request'`,
      )
    ).rows[0]?.id as string;
    const otherLineage = await insertProviderLineage({
      ordinal: 2,
      chargeState: "SETTLED",
      actualCostMicros: 1_000_000,
    });
    await expect(
      insertOutcome({
        id: "97000000-0000-4000-8000-000000000110",
        requestIntentId,
        providerRequestId: lineage.providerRequestId,
        providerBatchRequestId: lineage.providerBatchRequestId,
        providerUsageLedgerId: otherLineage.providerUsageLedgerId,
        providerTaskId: lineage.providerTaskId,
        rawCount: 14,
        effectiveCount: 10,
        newCount: 8,
        duplicateCount: 2,
        actualCostMicros: 1_000_000,
        cumulativeCostMicros: 1_000_000,
      }),
    ).rejects.toThrow(/lineage|provider request/i);
    await insertOutcome({
      id: "97000000-0000-4000-8000-000000000111",
      requestIntentId,
      ...lineage,
      rawCount: 14,
      effectiveCount: 10,
      newCount: 8,
      duplicateCount: 2,
      actualCostMicros: 1_000_000,
      cumulativeCostMicros: 1_000_000,
    });
    await insertWindowFact({
      id: "97000000-0000-4000-8000-000000000119",
      generationContractId: generationId,
      recommendationContextId: contextId,
      visiblePoolGeneration: 1,
      round: 1,
      windowOrdinal: 1,
      completedRequestCount: 1,
      rawCount: 14,
      effectiveCount: 10,
      newCount: 8,
      duplicateCount: 2,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
      requestSetFingerprint: hash("0"),
    });
    await expect(
      insertOutcome({
        id: "97000000-0000-4000-8000-000000000112",
        requestIntentId,
        ...lineage,
        rawCount: 14,
        effectiveCount: 10,
        newCount: 8,
        duplicateCount: 2,
        actualCostMicros: 1_000_000,
        cumulativeCostMicros: 1_000_000,
      }),
    ).rejects.toThrow(/unique constraint/i);
  });

  it("rejects a Round 2 authorization when Round 1 already has 100 unique candidates", async () => {
    const requestIntentId = "97000000-0000-4000-8000-000000000113";
    await insertIntent({
      id: requestIntentId,
      generationContractId: safeSupplyGenerationId,
      recommendationContextId: safeSupplyContextId,
      visiblePoolGeneration: 5,
      commercialSeedId: safeSupplySeedId,
      commercialSeedFingerprint: safeSupplySeedFingerprint,
      round: 1,
      requestFingerprint: hash("2"),
      pathFingerprint: hash("3"),
      idempotencyKey: "safe-supply-round-one",
      idempotencyHash: hash("4"),
      authorizedCostMicros: 0,
    });
    const lineage = await insertProviderLineage({
      ordinal: 5,
      chargeState: "SETTLED",
      actualCostMicros: 0,
    });
    await insertOutcome({
      id: "97000000-0000-4000-8000-000000000114",
      requestIntentId,
      generationContractId: safeSupplyGenerationId,
      recommendationContextId: safeSupplyContextId,
      visiblePoolGeneration: 5,
      ...lineage,
      rawCount: 100,
      effectiveCount: 100,
      newCount: 100,
      duplicateCount: 0,
      actualCostMicros: 0,
      cumulativeCostMicros: 0,
    });
    await insertWindowFact({
      id: "97000000-0000-4000-8000-000000000115",
      generationContractId: safeSupplyGenerationId,
      recommendationContextId: safeSupplyContextId,
      visiblePoolGeneration: 5,
      round: 1,
      windowOrdinal: 1,
      completedRequestCount: 1,
      rawCount: 100,
      effectiveCount: 100,
      newCount: 100,
      duplicateCount: 0,
      authorizedCostMicros: 0,
      settledCostMicros: 0,
      requestSetFingerprint: hash("5"),
    });
    await expect(
      insertRoundFact({
        id: "97000000-0000-4000-8000-000000000116",
        generationContractId: safeSupplyGenerationId,
        recommendationContextId: safeSupplyContextId,
        visiblePoolGeneration: 5,
        round: 1,
        completedWindowCount: 1,
        completedRequestCount: 1,
        rawCount: 100,
        effectiveCount: 100,
        newCount: 100,
        duplicateCount: 0,
        authorizedCostMicros: 0,
        settledCostMicros: 0,
        cumulativeCostMicros: 0,
        pathsExhausted: false,
        requestSetFingerprint: hash("6"),
        policyDecision: "START_ROUND_2",
        terminalReason: null,
      }),
    ).rejects.toThrow(/100|safe supply|round 2/i);
  });

  it("requires the final two completed windows to each satisfy the low-yield thresholds", async () => {
    const prepareWindow = async (input: {
      generationContractId: string;
      recommendationContextId: string;
      visiblePoolGeneration: number;
      commercialSeedId: string;
      commercialSeedFingerprint: string;
      ordinal: number;
      newCount: number;
      providerOrdinal: number;
    }) => {
      const suffix = input.providerOrdinal.toString().padStart(3, "0");
      const requestIntentId = `97000000-0000-4000-8001-000000000${suffix}`;
      await insertIntent({
        id: requestIntentId,
        generationContractId: input.generationContractId,
        recommendationContextId: input.recommendationContextId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        commercialSeedId: input.commercialSeedId,
        commercialSeedFingerprint: input.commercialSeedFingerprint,
        round: 1,
        windowOrdinal: input.ordinal,
        requestFingerprint: hash(String(input.providerOrdinal)),
        pathFingerprint: hash(input.ordinal === 1 ? "a" : "b"),
        idempotencyKey: `low-yield-${input.providerOrdinal}`,
        idempotencyHash: hash(String((input.providerOrdinal + 1) % 10)),
        authorizedCostMicros: 0,
      });
      const lineage = await insertProviderLineage({
        ordinal: input.providerOrdinal,
        chargeState: "SETTLED",
        actualCostMicros: 0,
      });
      await insertOutcome({
        id: `97000000-0000-4000-8002-000000000${suffix}`,
        requestIntentId,
        generationContractId: input.generationContractId,
        recommendationContextId: input.recommendationContextId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        ...lineage,
        rawCount: 100,
        effectiveCount: 100,
        newCount: input.newCount,
        duplicateCount: 100 - input.newCount,
        actualCostMicros: 0,
        cumulativeCostMicros: 0,
      });
      await insertWindowFact({
        id: `97000000-0000-4000-8003-000000000${suffix}`,
        generationContractId: input.generationContractId,
        recommendationContextId: input.recommendationContextId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        round: 1,
        windowOrdinal: input.ordinal,
        completedRequestCount: 1,
        rawCount: 100,
        effectiveCount: 100,
        newCount: input.newCount,
        duplicateCount: 100 - input.newCount,
        authorizedCostMicros: 0,
        settledCostMicros: 0,
        requestSetFingerprint: hash(input.ordinal === 1 ? "c" : "d"),
      });
    };

    await prepareWindow({
      generationContractId: lowYieldGenerationId,
      recommendationContextId: lowYieldContextId,
      visiblePoolGeneration: 6,
      commercialSeedId: lowYieldSeedId,
      commercialSeedFingerprint: lowYieldSeedFingerprint,
      ordinal: 1,
      newCount: 4,
      providerOrdinal: 6,
    });
    await prepareWindow({
      generationContractId: lowYieldGenerationId,
      recommendationContextId: lowYieldContextId,
      visiblePoolGeneration: 6,
      commercialSeedId: lowYieldSeedId,
      commercialSeedFingerprint: lowYieldSeedFingerprint,
      ordinal: 2,
      newCount: 5,
      providerOrdinal: 7,
    });
    await expect(
      insertRoundFact({
        id: "97000000-0000-4000-8000-000000000117",
        generationContractId: lowYieldGenerationId,
        recommendationContextId: lowYieldContextId,
        visiblePoolGeneration: 6,
        round: 1,
        completedWindowCount: 2,
        completedRequestCount: 2,
        rawCount: 200,
        effectiveCount: 200,
        newCount: 9,
        duplicateCount: 191,
        authorizedCostMicros: 0,
        settledCostMicros: 0,
        cumulativeCostMicros: 0,
        pathsExhausted: false,
        requestSetFingerprint: hash("7"),
        policyDecision: "STOP",
        terminalReason: "LOW_YIELD",
      }),
    ).rejects.toThrow(/low.yield|window/i);

    await prepareWindow({
      generationContractId: validLowYieldGenerationId,
      recommendationContextId: validLowYieldContextId,
      visiblePoolGeneration: 7,
      commercialSeedId: validLowYieldSeedId,
      commercialSeedFingerprint: validLowYieldSeedFingerprint,
      ordinal: 1,
      newCount: 4,
      providerOrdinal: 8,
    });
    await prepareWindow({
      generationContractId: validLowYieldGenerationId,
      recommendationContextId: validLowYieldContextId,
      visiblePoolGeneration: 7,
      commercialSeedId: validLowYieldSeedId,
      commercialSeedFingerprint: validLowYieldSeedFingerprint,
      ordinal: 2,
      newCount: 3,
      providerOrdinal: 9,
    });
    await insertRoundFact({
      id: "97000000-0000-4000-8000-000000000118",
      generationContractId: validLowYieldGenerationId,
      recommendationContextId: validLowYieldContextId,
      visiblePoolGeneration: 7,
      round: 1,
      completedWindowCount: 2,
      completedRequestCount: 2,
      rawCount: 200,
      effectiveCount: 200,
      newCount: 7,
      duplicateCount: 193,
      authorizedCostMicros: 0,
      settledCostMicros: 0,
      cumulativeCostMicros: 0,
      pathsExhausted: false,
      requestSetFingerprint: hash("8"),
      policyDecision: "STOP",
      terminalReason: "LOW_YIELD",
    });
  });

  it("enforces the one-dollar rounds, two-dollar generation cap, and changed Round 2 path", async () => {
    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000120",
        generationContractId: budgetGenerationId,
        recommendationContextId: budgetContextId,
        visiblePoolGeneration: 3,
        commercialSeedId: budgetSeedId,
        commercialSeedFingerprint: budgetSeedFingerprint,
        round: 1,
        requestFingerprint: hash("1"),
        pathFingerprint: hash("2"),
        idempotencyKey: "over-authorized",
        idempotencyHash: hash("3"),
        authorizedCostMicros: 1_000_001,
      }),
    ).rejects.toThrow(/check constraint|authorization exceeds|budget/i);

    await client.query(
      `INSERT INTO backlinks.${roundTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, round_number,
         completed_window_count, completed_request_count,
         raw_candidate_count, effective_candidate_count, new_unique_count,
         duplicate_count, new_unique_rate_numerator,
         new_unique_rate_denominator, round_authorized_cost_micros,
         round_settled_cost_micros, cumulative_settled_cost_micros,
         charge_state, paths_exhausted, changed_dimensions,
         canonical_request_set_fingerprint, policy_decision, terminal_reason,
         completed_at, created_by
       )
       SELECT
         '97000000-0000-4000-8000-000000000121', organization_id,
         workspace_id, website_project_id, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, pool_contract_version, $1, 1, 1, 1, 14, 10, 8, 2,
          8, 10, 1000000, 1000000, 1000000, 'SETTLED', false,
          ARRAY[]::text[],
         $2, 'START_ROUND_2', NULL, statement_timestamp(),
         'phase3-schema-test'
       FROM backlinks.${intentTable}
       WHERE idempotency_key='concurrent-request'`,
      [policyVersion, hash("4")],
    );

    await expect(
      insertIntent({
        id: "97000000-0000-4000-8000-000000000122",
        round: 2,
        windowOrdinal: 2,
        requestFingerprint: hash("d"),
        pathFingerprint: hash("5"),
        idempotencyKey: "round2-duplicate-request",
        idempotencyHash: hash("6"),
      }),
    ).rejects.toThrow(/unique constraint/i);

    const round2IntentId = "97000000-0000-4000-8000-000000000123";
    await insertIntent({
      id: round2IntentId,
      round: 2,
      windowOrdinal: 2,
      requestFingerprint: hash("7"),
      pathFingerprint: hash("8"),
      idempotencyKey: "round2-request",
      idempotencyHash: hash("9"),
      authorizedCostMicros: 1_000_000,
    });
    const round2Lineage = await insertProviderLineage({
      ordinal: 3,
      chargeState: "SETTLED",
      actualCostMicros: 1_000_000,
    });
    await insertOutcome({
      id: "97000000-0000-4000-8000-000000000124",
      requestIntentId: round2IntentId,
      ...round2Lineage,
      rawCount: 13,
      effectiveCount: 10,
      newCount: 6,
      duplicateCount: 4,
      actualCostMicros: 1_000_000,
      cumulativeCostMicros: 2_000_000,
    });
    await insertWindowFact({
      id: "97000000-0000-4000-8000-000000000127",
      generationContractId: generationId,
      recommendationContextId: contextId,
      visiblePoolGeneration: 1,
      round: 2,
      windowOrdinal: 2,
      completedRequestCount: 1,
      rawCount: 13,
      effectiveCount: 10,
      newCount: 6,
      duplicateCount: 4,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
      requestSetFingerprint: hash("9"),
    });

    await client.query(
      `INSERT INTO backlinks.${roundTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, round_number,
         completed_window_count, completed_request_count,
         raw_candidate_count, effective_candidate_count, new_unique_count,
         duplicate_count, new_unique_rate_numerator,
         new_unique_rate_denominator, round_authorized_cost_micros,
         round_settled_cost_micros, cumulative_settled_cost_micros,
         charge_state, paths_exhausted, changed_dimensions,
         canonical_request_set_fingerprint, policy_decision, terminal_reason,
         completed_at, created_by
       ) VALUES (
         '97000000-0000-4000-8000-000000000125', $1, $2, $3, $4, $5, 1,
         $6, 'recommendation-pool.v2', $7, 2, 1, 1, 13, 10, 6, 4, 6, 10,
          1000000, 1000000, 2000000, 'SETTLED', true,
          ARRAY['SOURCE']::text[],
         $8, 'STOP', 'PATHS_EXHAUSTED', statement_timestamp(),
         'phase3-schema-test'
       )`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        generationId,
        contextId,
        inputPinId,
        policyVersion,
        hash("a"),
      ],
    );
    await expect(
      client.query(
        `INSERT INTO backlinks.${roundTable} (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, pool_contract_version,
           discovery_budget_policy_version, round_number,
           completed_window_count, completed_request_count,
           raw_candidate_count, effective_candidate_count, new_unique_count,
           duplicate_count, new_unique_rate_numerator,
           new_unique_rate_denominator, round_authorized_cost_micros,
           round_settled_cost_micros, cumulative_settled_cost_micros,
           charge_state, paths_exhausted, changed_dimensions,
           canonical_request_set_fingerprint, policy_decision, terminal_reason,
           completed_at, created_by
         ) VALUES (
           '97000000-0000-4000-8000-000000000126', $1, $2, $3, $4, $5, 3,
           $6, 'recommendation-pool.v2', $7, 1, 1, 1, 1, 1, 1, 0, 1, 1,
           1000000, 1000000, 2000001, 'SETTLED', true, ARRAY[]::text[],
           $8, 'STOP', 'BUDGET_EXHAUSTED', statement_timestamp(),
           'phase3-schema-test'
         )`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          budgetGenerationId,
          budgetContextId,
          inputPinId,
          policyVersion,
          hash("b"),
        ],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("persists unknown charge only as null-cost fail-closed facts", async () => {
    const unknownIntentId = "97000000-0000-4000-8000-000000000130";
    await insertIntent({
      id: unknownIntentId,
      generationContractId: unknownGenerationId,
      recommendationContextId: unknownContextId,
      visiblePoolGeneration: 2,
      commercialSeedId: unknownSeedId,
      commercialSeedFingerprint: unknownSeedFingerprint,
      round: 1,
      requestFingerprint: hash("c"),
      pathFingerprint: hash("d"),
      idempotencyKey: "unknown-charge",
      idempotencyHash: hash("e"),
    });
    const lineage = await insertProviderLineage({
      ordinal: 4,
      chargeState: "UNKNOWN_CHARGE",
    });
    await insertOutcome({
      id: "97000000-0000-4000-8000-000000000131",
      requestIntentId: unknownIntentId,
      generationContractId: unknownGenerationId,
      recommendationContextId: unknownContextId,
      visiblePoolGeneration: 2,
      ...lineage,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
      actualCostMicros: null,
      cumulativeCostMicros: null,
      status: "UNKNOWN_CHARGE",
      chargeState: "UNKNOWN_CHARGE",
    });
    await insertWindowFact({
      id: "97000000-0000-4000-8000-000000000135",
      generationContractId: unknownGenerationId,
      recommendationContextId: unknownContextId,
      visiblePoolGeneration: 2,
      round: 1,
      windowOrdinal: 1,
      completedRequestCount: 1,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
      authorizedCostMicros: 500_000,
      settledCostMicros: null,
      chargeState: "UNKNOWN_CHARGE",
      requestSetFingerprint: hash("e"),
    });
    await expect(
      client.query(
        `INSERT INTO backlinks.${roundTable} (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, pool_contract_version,
           discovery_budget_policy_version, round_number,
           completed_window_count, completed_request_count,
           raw_candidate_count, effective_candidate_count, new_unique_count,
           duplicate_count, new_unique_rate_numerator,
           new_unique_rate_denominator, round_authorized_cost_micros,
           round_settled_cost_micros, cumulative_settled_cost_micros,
           charge_state, paths_exhausted, changed_dimensions,
           canonical_request_set_fingerprint, policy_decision, terminal_reason,
           completed_at, created_by
         ) VALUES (
           '97000000-0000-4000-8000-000000000132', $1, $2, $3, $4, $5, 2,
           $6, 'recommendation-pool.v2', $7, 1, 1, 1, 0, 0, 0, 0, 0, 0,
           500000, NULL, NULL, 'UNKNOWN_CHARGE', false, ARRAY[]::text[],
           $8, 'START_ROUND_2', NULL, statement_timestamp(),
           'phase3-schema-test'
         )`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          unknownGenerationId,
          unknownContextId,
          inputPinId,
          policyVersion,
          hash("f"),
        ],
      ),
    ).rejects.toThrow(/check constraint/i);
    await client.query(
      `INSERT INTO backlinks.${roundTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, round_number,
         completed_window_count, completed_request_count,
         raw_candidate_count, effective_candidate_count, new_unique_count,
         duplicate_count, new_unique_rate_numerator,
         new_unique_rate_denominator, round_authorized_cost_micros,
         round_settled_cost_micros, cumulative_settled_cost_micros,
         charge_state, paths_exhausted, changed_dimensions,
         canonical_request_set_fingerprint, policy_decision, terminal_reason,
         completed_at, created_by
       ) VALUES (
         '97000000-0000-4000-8000-000000000133', $1, $2, $3, $4, $5, 2,
         $6, 'recommendation-pool.v2', $7, 1, 1, 1, 0, 0, 0, 0, 0, 0,
         500000, NULL, NULL, 'UNKNOWN_CHARGE', false, ARRAY[]::text[],
         $8, 'STOP', 'UNKNOWN_CHARGE', statement_timestamp(),
         'phase3-schema-test'
       )`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        unknownGenerationId,
        unknownContextId,
        inputPinId,
        policyVersion,
        hash("f"),
      ],
    );
  });

  it("writes a singleton terminal fact without Phase 4 canonical completion fields", async () => {
    await expect(
      client.query(
        `INSERT INTO backlinks.${terminalTable} (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, pool_contract_version,
           discovery_budget_policy_version, effective_unique_candidate_count,
           terminal_reason, total_settled_cost_micros, charge_state,
           completed_round_count, completed_window_count,
           canonical_request_set_fingerprint, completed_at, created_by
         ) VALUES (
           '97000000-0000-4000-8000-000000000140', $1, $2, $3, $4, $5, 1,
           $6, 'recommendation-pool.v2', $7, 1001, 'CANDIDATE_LIMIT_REACHED',
           1000000, 'SETTLED', 2, 2, $8, statement_timestamp(),
           'phase3-schema-test'
         )`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          generationId,
          contextId,
          inputPinId,
          policyVersion,
          hash("1"),
        ],
      ),
    ).rejects.toThrow(/check constraint/i);
    await client.query(
      `INSERT INTO backlinks.${terminalTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, effective_unique_candidate_count,
         terminal_reason, total_settled_cost_micros, charge_state,
         completed_round_count, completed_window_count,
         canonical_request_set_fingerprint, completed_at, created_by
       ) VALUES (
         '97000000-0000-4000-8000-000000000141', $1, $2, $3, $4, $5, 1,
          $6, 'recommendation-pool.v2', $7, 14, 'PATHS_EXHAUSTED', 2000000,
         'SETTLED', 2, 2, $8, statement_timestamp(), 'phase3-schema-test'
       )`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        generationId,
        contextId,
        inputPinId,
        policyVersion,
        hash("2"),
      ],
    );
    await expect(
      client.query(
        `INSERT INTO backlinks.${terminalTable} (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, pool_contract_version,
           discovery_budget_policy_version, effective_unique_candidate_count,
           terminal_reason, total_settled_cost_micros, charge_state,
           completed_round_count, completed_window_count,
           canonical_request_set_fingerprint, completed_at, created_by
         ) SELECT
           '97000000-0000-4000-8000-000000000142', organization_id,
           workspace_id, website_project_id, generation_contract_id,
           recommendation_context_version_id, visible_pool_generation,
           input_pin_id, pool_contract_version,
           discovery_budget_policy_version, effective_unique_candidate_count,
           terminal_reason, total_settled_cost_micros, charge_state,
           completed_round_count, completed_window_count,
           canonical_request_set_fingerprint, completed_at,
           'phase3-schema-test'
         FROM backlinks.${terminalTable}
         WHERE generation_contract_id=$1`,
        [generationId],
      ),
    ).rejects.toThrow(/unique constraint/i);
    expect(
      (
        await client.query(
          `SELECT effective_unique_candidate_count AS "candidateCount",
                  canonical_batch_size AS "batchSize",
                  canonical_batch_count AS "batchCount",
                  canonical_order_fingerprint AS "orderFingerprint",
                  discovery_terminal_reason AS "completionReason",
                  discovery_completed_at AS "completionAt"
             FROM backlinks.backlink_recommendation_generation_contracts
            WHERE id=$1`,
          [generationId],
        )
      ).rows,
    ).toEqual([
      {
        candidateCount: null,
        batchSize: null,
        batchCount: null,
        orderFingerprint: null,
        completionReason: null,
        completionAt: null,
      },
    ]);

    await client.query(
      `INSERT INTO backlinks.${terminalTable} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         discovery_budget_policy_version, effective_unique_candidate_count,
         terminal_reason, total_settled_cost_micros, charge_state,
         completed_round_count, completed_window_count,
         canonical_request_set_fingerprint, completed_at, created_by
       ) VALUES (
         '97000000-0000-4000-8000-000000000143', $1, $2, $3, $4, $5, 2,
         $6, 'recommendation-pool.v2', $7, 0, 'UNKNOWN_CHARGE', NULL,
         'UNKNOWN_CHARGE', 1, 1, $8, statement_timestamp(),
         'phase3-schema-test'
       )`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        unknownGenerationId,
        unknownContextId,
        inputPinId,
        policyVersion,
        hash("3"),
      ],
    );
  });

  it("rejects UPDATE and DELETE for every append-only discovery fact", async () => {
    for (const table of [
      intentTable,
      outcomeTable,
      windowTable,
      roundTable,
      terminalTable,
    ]) {
      await expect(
        client.query(
          `UPDATE backlinks.${table}
              SET created_by='mutated'
            WHERE organization_id=$1`,
          [organizationId],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        client.query(
          `DELETE FROM backlinks.${table}
            WHERE organization_id=$1`,
          [organizationId],
        ),
      ).rejects.toThrow(/immutable/i);
    }
  });
});
