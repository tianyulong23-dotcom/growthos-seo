import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createRecommendationHybridSupplyRuntime } from "../../../src/modules/backlinks/runtime/recommendation-hybrid-supply-runtime.js";
import { createRecommendationFeedQuery } from "../../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import { createRecommendationFeedRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-feed.repository.js";
import { createRecommendationUserReleaseRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import { createActorContext, createProjectContext, createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { recoverRecommendationPoolV2CanonicalBatchPreparation } from "../../../src/modules/backlinks/activities/recommendation-pool-v2.activity.js";
import { createRecommendationPoolV2CandidateAdmissionService } from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-candidate-admission.service.js";
import { createRecommendationPoolV2ContactPreparationService } from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-contact-preparation.service.js";
import { applyBacklinksDeploymentManifest } from "../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";
import {
  createRecommendationPoolV2CandidateRepository,
  type RecommendationPoolV2CanonicalMaterialization,
} from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-candidate.repository.js";
import { createRecommendationPoolV2Repository } from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.js";
import { normalizeCommercialDiscoveryResponse } from "../../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";
import {
  type BacklinkTenantPool,
  withBacklinkTenantTransaction,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
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
type Pool = BacklinkTenantPool & Readonly<{ end(): Promise<void> }>;
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
  `019aa400-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const actorId = "phase4-canonical-batch-test";
const tenantRole = `phase4_canonical_${randomBytes(6).toString("hex")}`;
const tenantPassword = "phase4-canonical";

type ProjectFixture = Readonly<{
  websiteProjectId: string;
  profileId: string;
  inputPinId: string;
  contextId: string;
  generationId: string;
  contractId: string;
  blueprintId: string;
  seedId: string;
  blueprintSeedId: string;
  visiblePoolGeneration: number;
  candidateCount: number;
}>;

const projectA = buildProjectFixture(100, 26, 1);
const projectB = buildProjectFixture(1000, 1, 2);
const projectC = buildProjectFixture(2000, 1, 2);
const projectD = buildProjectFixture(3000, 0, 1);
const projectE = buildProjectFixture(4000, 1, 1);

function buildProjectFixture(
  base: number,
  candidateCount: number,
  visiblePoolGeneration: number,
): ProjectFixture {
  return Object.freeze({
    websiteProjectId: id(base),
    profileId: id(base + 1),
    inputPinId: id(base + 2),
    contextId: id(base + 3),
    generationId: id(base + 4),
    contractId: id(base + 5),
    blueprintId: id(base + 6),
    seedId: id(base + 7),
    blueprintSeedId: id(base + 8),
    visiblePoolGeneration,
    candidateCount,
  });
}

const materializationsByProject = new Map<
  string,
  readonly RecommendationPoolV2CanonicalMaterialization[]
>();

function materializationAt(
  project: ProjectFixture,
  index: number,
): RecommendationPoolV2CanonicalMaterialization {
  const materialization = materializationsByProject.get(
    project.websiteProjectId,
  )?.[index];
  if (materialization === undefined) {
    throw new Error("Phase 4 V2 candidate materialization fixture is missing.");
  }
  return materialization;
}

async function installMigrations(client: Client): Promise<void> {
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
    targetRevision: "0100",
  });
}

async function insertProjectFixture(
  client: Client,
  project: ProjectFixture,
  activeGeneration: Readonly<{
    generationId: string;
    visiblePoolGeneration: number;
    migrationState?: "V2_READY" | "V2_ACTIVE";
  }> = {
    generationId: project.generationId,
    visiblePoolGeneration: project.visiblePoolGeneration,
  },
  candidateDomains?: readonly string[],
  canonicalDomain?: string,
): Promise<void> {
  const suffix = project.websiteProjectId.slice(-4);
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id,organization_id,workspace_id,website_project_id,
       profile_version_id,promotion_target_version_id,
       keywords_and_topics,products_and_services,target_urls,
       target_audiences,partnership_goals,market,location,language,
       authorized_discovery_sources,immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'["phase4 canonical"]'::jsonb,
       '["GrowthOS"]'::jsonb,'[]'::jsonb,'["publishers"]'::jsonb,
       '["editorial"]'::jsonb,'US','United States','en','[]'::jsonb,
       $7,$8
     )`,
    [
      project.profileId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `profile-${suffix}`,
      `target-${suffix}`,
      `profile-fingerprint-${suffix}`,
      actorId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_generation_input_pins (
       id,organization_id,workspace_id,website_project_id,
       project_context_version,site_profile_version_id,
       outreach_profile_version_id,promotion_target_version_id,
       keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,
       market,qualification_contract_version,immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,1,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,
       'US','recommendation-pool-admission.v2',$8,$9
     )`,
    [
      project.inputPinId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `site-profile-${suffix}`,
      project.profileId,
      `target-${suffix}`,
      `pin-fingerprint-${suffix}`,
      actorId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id,organization_id,workspace_id,website_project_id,snapshot_version,
       project_status,canonical_domain,locale,country_code,
       profile_version_id,promotion_target_version_id,products,keywords,
       target_audiences,created_by
     ) VALUES (
       $1,$2,$3,$4,1,'ACTIVE',$5,'en-US','US',$6,$7,
       '["GrowthOS"]'::jsonb,'["phase4 canonical"]'::jsonb,
       '["publishers"]'::jsonb,$8
     )`,
    [
      project.contextId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      canonicalDomain ?? `project-${suffix}.com`,
      `site-profile-${suffix}`,
      `target-${suffix}`,
      actorId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,input_pin_id,
       qualification_contract_version,visibility_contract_version,
       score_model_version,metric_scope,market,location,language,
       traffic_location_code,traffic_language_code,request_fingerprints,
       creator_worker_contract_version,created_by,pool_contract_version,
       seed_contract_version,release_contract_version,
       recommendation_marker_version,discovery_budget_policy_version,
       discovery_completed_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'recommendation-pool-admission.v2',
       'recommendation-pool-release-visibility.v2',
       'recommendation-pool-materialization.v2',
       'TARGET_MARKET','US','United States','en',2840,'en','{}'::jsonb,
       'recommendation-pool-worker.v2',$8,'recommendation-pool.v2',
       'recommendation-seed.v2','recommendation-release.v2',
       'recommendation-marker.v2','recommendation-discovery-budget.v1',
       CASE WHEN $9::boolean THEN statement_timestamp() ELSE NULL END
     )`,
    [
      project.generationId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.contextId,
      project.visiblePoolGeneration,
      project.inputPinId,
      actorId,
      activeGeneration.migrationState === "V2_ACTIVE" &&
        activeGeneration.generationId === project.generationId,
    ],
  );
  if (activeGeneration.generationId !== project.generationId) {
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,input_pin_id,
         qualification_contract_version,visibility_contract_version,
         score_model_version,metric_scope,market,location,language,
         traffic_location_code,traffic_language_code,request_fingerprints,
         creator_worker_contract_version,created_by,pool_contract_version,
         seed_contract_version,release_contract_version,
         recommendation_marker_version,discovery_budget_policy_version,
         discovery_completed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'recommendation-pool-admission.v2',
         'recommendation-pool-release-visibility.v2',
         'recommendation-pool-materialization.v2',
         'TARGET_MARKET','US','United States','en',2840,'en','{}'::jsonb,
         'recommendation-pool-worker.v2',$8,'recommendation-pool.v2',
         'recommendation-seed.v2','recommendation-release.v2',
         'recommendation-marker.v2','recommendation-discovery-budget.v1',
         CASE WHEN $9::boolean THEN statement_timestamp() ELSE NULL END
       )`,
      [
        activeGeneration.generationId,
        organizationId,
        workspaceId,
        project.websiteProjectId,
        project.contextId,
        activeGeneration.visiblePoolGeneration,
        project.inputPinId,
        actorId,
        activeGeneration.migrationState === "V2_ACTIVE",
      ],
    );
  }
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
       id,organization_id,workspace_id,website_project_id,
       pool_contract_version,migration_state,generation_contract_id,
       recommendation_context_version_id,visible_pool_generation,input_pin_id,
       activated_at,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,'recommendation-pool.v2',$10,$5,$6,$7,$8,
       CASE WHEN $10='V2_ACTIVE' THEN statement_timestamp() ELSE NULL END,
       $9,$9
     )`,
    [
      project.contractId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      activeGeneration.generationId,
      project.contextId,
      activeGeneration.visiblePoolGeneration,
      project.inputPinId,
      actorId,
      activeGeneration.migrationState ?? "V2_READY",
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,generator,schema_version,
       prompt_version,rule_version,blueprint,evidence_refs,generated_at,
       created_by
     ) VALUES (
       $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK',
       'recommendation-blueprint.v2','recommendation-seed.v2',
       'recommendation-discovery.v2','{}'::jsonb,'[]'::jsonb,
       statement_timestamp(),$6
     )`,
    [
      project.blueprintId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.contextId,
      actorId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
       id,organization_id,workspace_id,website_project_id,
       generation_contract_id,recommendation_context_version_id,
       visible_pool_generation,input_pin_id,seed_kind,raw_value,
       normalized_value,source,validation_status,validation_reason_codes,
       evidence_refs,confidence_band,seed_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,'KEYWORD','Phase4 Canonical',
       'phase4 canonical','USER_INPUT','VERIFIED','[]'::jsonb,
       '["phase4:test"]'::jsonb,'HIGH',$9,$10
     )`,
    [
      project.seedId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.generationId,
      project.contextId,
      project.visiblePoolGeneration,
      project.inputPinId,
      `seed-fingerprint-${suffix}`,
      actorId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_blueprint_seeds (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       seed_id,generation_contract_id,recommendation_context_version_id,
       visible_pool_generation,seed_ordinal,seed_fingerprint,created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)`,
    [
      project.blueprintSeedId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.blueprintId,
      project.seedId,
      project.generationId,
      project.contextId,
      project.visiblePoolGeneration,
      `seed-fingerprint-${suffix}`,
      actorId,
    ],
  );
  const candidateRepository =
    createRecommendationPoolV2CandidateRepository(client);
  const lineage = {
    organizationId,
    workspaceId,
    websiteProjectId: project.websiteProjectId,
    generationContractId: project.generationId,
    recommendationContextVersionId: project.contextId,
    visiblePoolGeneration: project.visiblePoolGeneration,
    inputPinId: project.inputPinId,
  };
  const materializations: RecommendationPoolV2CanonicalMaterialization[] = [];
  for (let index = 0; index < project.candidateCount; index += 1) {
    const domain = candidateDomains?.[index] ?? `phase4-${suffix}-${String(index + 1).padStart(2, "0")}.com`;
    const authority = await candidateRepository.recordCandidate({
      ...lineage,
      canonicalDomain: domain,
      admissionState: "ADMITTED",
      decisionEvidence: {
        contractVersion: "recommendation-pool-admission.v2",
        passedRequiredExclusions: true,
      },
      firstSeenRequestIntent: "DISCOVERY",
      recommended: true,
      recommendationReasonCodes: [
        "RELEVANCE_TARGET_MARKET_SEARCH_TOPIC",
        "EVIDENCE_RELIABLE_METRIC",
      ],
      firstSeenAt: "2026-09-02T00:00:00.000Z",
      decidedAt: "2026-09-02T00:00:00.000Z",
      createdBy: actorId,
    });
    await candidateRepository.appendSource({
      organizationId,
      workspaceId,
      websiteProjectId: project.websiteProjectId,
      generationCandidateId: authority.id,
      requestIntent: "DISCOVERY",
      providerOutcome: "SUCCEEDED",
      sourceType: "GATE2_FIXTURE",
      discoveredUrl: `https://${domain}/`,
      sourceRef: `phase4:candidate:${index + 1}`,
      evidencePayload: {
        contractVersion: "recommendation-pool-v2-candidate-source.v1",
        canonicalDomain: domain,
      },
      observedAt: "2026-09-02T00:00:01.000Z",
      createdBy: actorId,
    });
    for (const [metricType, metricValue] of [
      ["TRAFFIC_ORGANIC_ETV", index + 100],
      ["AUTHORITY_RANK", index + 10],
      ["SPAM_SCORE", index % 5],
    ] as const) {
      await candidateRepository.appendMetric({
        organizationId,
        workspaceId,
        websiteProjectId: project.websiteProjectId,
        generationCandidateId: authority.id,
        metricType,
        provider: "fixture",
        endpoint: "phase4/canonical",
        market: "US",
        location: "United States",
        language: "en",
        requestIntent: "CARD_ENRICHMENT",
        valueState: "AVAILABLE",
        metricValue,
        artifactRef: `phase4:${metricType}:${index + 1}`,
        observedAt: new Date(Date.now() - 3_600_000).toISOString(),
        createdBy: actorId,
      });
    }
    const materialized = await candidateRepository.materializeCandidate({
      ...lineage,
      generationCandidateId: authority.id,
      createdBy: actorId,
    });
    if (index === 0) {
      const replay = await candidateRepository.materializeCandidate({
        ...lineage,
        generationCandidateId: authority.id,
        createdBy: actorId,
      });
      if (JSON.stringify(replay) !== JSON.stringify(materialized)) {
        throw new Error("Phase 4 V2 materialization replay diverged.");
      }
    }
    materializations.push(materialized);
  }
  materializationsByProject.set(
    project.websiteProjectId,
    Object.freeze(materializations),
  );
}

describe("Phase 4 canonical batch persistence", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let tenantPool: Pool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await installMigrations(admin);
    await admin.query(`
      CREATE ROLE "${tenantRole}" LOGIN PASSWORD '${tenantPassword}'
        NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${tenantRole}";
    `);
    await insertProjectFixture(admin, projectA);
    await insertProjectFixture(admin, projectB);
    await insertProjectFixture(admin, projectC, {
      generationId: id(1990),
      visiblePoolGeneration: 1,
      migrationState: "V2_ACTIVE",
    });
    await insertProjectFixture(admin, projectD);
    await insertProjectFixture(admin, projectE);
    const tenantConnection = new URL(harness.connectionString);
    tenantConnection.username = tenantRole;
    tenantConnection.password = tenantPassword;
    tenantPool = new PgPool({
      connectionString: tenantConnection.toString(),
      options: "-c search_path=backlinks,public",
      max: 4,
    });
  }, 180_000);

  afterAll(async () => {
    await tenantPool?.end();
    await admin?.query(`DROP ROLE IF EXISTS "${tenantRole}"`);
    await admin?.end();
    await harness?.stop();
  });

  it("round-trips the captured Awolvision self-domain artifact through admission", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectD.websiteProjectId,
    };
    const input = {
      ...scope,
      generationContractId: projectD.generationId,
      recommendationContextVersionId: projectD.contextId,
      visiblePoolGeneration: projectD.visiblePoolGeneration,
      inputPinId: projectD.inputPinId,
      projectDomain: "awolvision.com",
      market: "US",
      location: "United States",
      language: "en",
      observations: [
        {
          requestIntentId: "979458f5-c6e1-43ba-834e-7581125c586d",
          providerOutcome: "SUCCEEDED",
          artifact: {
            endpoint: "/v3/serp/google/organic/task_post",
            sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
            requestFingerprint:
              "e2f37b3f427d7f07db3a4b97f02224cf1d2862c7bf1319af2b60e80ba278e858",
            responseSchemaVersion:
              "dataforseo.serp-google-organic-task-post.v2",
            collectedAt: "2026-09-04T17:12:01.156Z",
            costMicros: 600,
            providerTaskIds: ["09041710-1594-0066-0000-d69f2fcf6a31"],
            plannerLineage: {
              blueprintId: "6565b5c1-5219-417a-9773-b8b452568b87",
              queryId:
                "5efed6d3ee5893572eec95a05333320a790fa725bf0011e6c6b2bca70148a2f7",
            },
            candidates: [
              {
                canonicalDomain: "awolvision.com",
                discoveryUrls: [
                  "https://awolvision.com/blogs/awol-vision-blog/gray-vs-white-projector-screen",
                ],
                backlinkPageEvidence: [],
                rank: null,
                traffic: null,
                backlinkCount: null,
                referringDomainCount: null,
                spamScore: null,
                countryCode: null,
                evidenceRefs: [
                  "dataforseo:/v3/serp/google/organic/task_post:e2f37b3f427d7f07db3a4b97f02224cf1d2862c7bf1319af2b60e80ba278e858:awolvision.com",
                ],
              },
            ],
          },
        },
      ],
      createdBy: actorId,
    } as const;

    const ingest = () =>
      withBacklinkTenantTransaction(tenantPool, scope, (client) =>
        createRecommendationPoolV2CandidateAdmissionService(
          createRecommendationPoolV2CandidateRepository(client),
        ).ingestArtifacts(input),
      );

    await expect(ingest()).resolves.toEqual({
      rawCandidateCount: 1,
      canonicalCandidateCount: 1,
      newUniqueCount: 1,
      duplicateCount: 0,
      admittedCount: 0,
      hardExcludedCount: 1,
      materializedCount: 0,
    });
    await expect(ingest()).resolves.toEqual({
      rawCandidateCount: 1,
      canonicalCandidateCount: 1,
      newUniqueCount: 0,
      duplicateCount: 1,
      admittedCount: 0,
      hardExcludedCount: 1,
      materializedCount: 0,
    });
  }, 120_000);

  it("uses immutable V2 authority facts for admission, history exclusions, materialization, and tenant isolation", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectA.websiteProjectId,
    };
    const firstMaterialization = materializationAt(projectA, 0);
    const inspected = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      async (client) => {
        const repository =
          createRecommendationPoolV2CandidateRepository(client);
        const admittedBefore = await client.query(
          `SELECT backlink_recommendation_generation_admitted_count(
                    $1,$2,$3,$4
                  ) count`,
          [
            organizationId,
            workspaceId,
            projectA.websiteProjectId,
            projectA.generationId,
          ],
        );
        await client.query("SAVEPOINT attempted_v1_candidate_mutation");
        let attemptedV1MutationError = "";
        try {
          await client.query(
            `UPDATE backlink_commercial_candidates
                SET commercial_score='{"score":100}'::jsonb,
                    score_model_version='recommendation-commercial-fit.v4',
                    state='excluded',
                    updated_at=statement_timestamp(),
                    updated_by=$2,
                    version=version+1
              WHERE id=$1`,
            [firstMaterialization.candidateId, actorId],
          );
        } catch (error) {
          attemptedV1MutationError =
            error instanceof Error ? error.message : String(error);
        }
        await client.query(
          "ROLLBACK TO SAVEPOINT attempted_v1_candidate_mutation",
        );
        await client.query("RELEASE SAVEPOINT attempted_v1_candidate_mutation");
        if (attemptedV1MutationError.length === 0) {
          throw new Error(
            "V1 candidate score/state mutation was not rejected.",
          );
        }
        const admittedAfterV1MutationAttempt = await client.query(
          `SELECT backlink_recommendation_generation_admitted_count(
                    $1,$2,$3,$4
                  ) count`,
          [
            organizationId,
            workspaceId,
            projectA.websiteProjectId,
            projectA.generationId,
          ],
        );
        await repository.appendMetric({
          organizationId,
          workspaceId,
          websiteProjectId: projectA.websiteProjectId,
          generationCandidateId: firstMaterialization.generationCandidateId,
          metricType: "TRAFFIC_ORGANIC_ETV",
          provider: "fixture",
          endpoint: "phase4/unavailable",
          market: "US",
          location: "United States",
          language: "en",
          requestIntent: "CARD_ENRICHMENT",
          valueState: "UNAVAILABLE",
          metricValue: null,
          artifactRef: "phase4:traffic-unavailable:1",
          observedAt: "2026-09-01T23:59:59.000Z",
          createdBy: actorId,
        });
        const selfDomain = await repository.recordCandidate({
          organizationId,
          workspaceId,
          websiteProjectId: projectA.websiteProjectId,
          generationContractId: projectA.generationId,
          recommendationContextVersionId: projectA.contextId,
          visiblePoolGeneration: projectA.visiblePoolGeneration,
          inputPinId: projectA.inputPinId,
          canonicalDomain: "project-0100.com",
          admissionState: "ADMITTED",
          decisionEvidence: {
            contractVersion: "recommendation-pool-admission.v2",
            passedRequiredExclusions: true,
          },
          firstSeenRequestIntent: "DISCOVERY",
          recommended: true,
          recommendationReasonCodes: ["RELEVANCE_TARGET_MARKET_SEARCH_TOPIC"],
          firstSeenAt: "2026-09-03T00:00:00.000Z",
          decidedAt: "2026-09-03T00:00:00.000Z",
          createdBy: actorId,
        });
        await repository.appendSource({
          organizationId,
          workspaceId,
          websiteProjectId: projectA.websiteProjectId,
          generationCandidateId: selfDomain.id,
          requestIntent: "DISCOVERY",
          providerOutcome: "SUCCEEDED",
          sourceType: "GATE2_HISTORY_REGISTRY",
          discoveredUrl: "https://project-0100.com/",
          sourceRef: "phase4:self-domain",
          evidencePayload: {
            contractVersion: "recommendation-pool-v2-candidate-source.v1",
            canonicalDomain: "project-0100.com",
          },
          observedAt: "2026-09-03T00:00:01.000Z",
          createdBy: actorId,
        });
        const admittedAfter = await client.query(
          `SELECT backlink_recommendation_generation_admitted_count(
                    $1,$2,$3,$4
                  ) count`,
          [
            organizationId,
            workspaceId,
            projectA.websiteProjectId,
            projectA.generationId,
          ],
        );
        const authority = await client.query(
          `SELECT
             count(*)::integer "candidateCount",
             count(*) FILTER (
               WHERE admission_state='ADMITTED'
             )::integer "admittedCount",
             count(*) FILTER (
               WHERE admission_state='EXCLUDED'
             )::integer "excludedCount"
           FROM backlink_recommendation_generation_candidates`,
        );
        const exclusion = await client.query(
          `SELECT admission_state "admissionState",
                  exclusion_reason_code "exclusionReasonCode",
                  exclusion_evidence "exclusionEvidence",
                  decision_evidence "decisionEvidence",
                  recommended,
                  recommendation_reason_codes "recommendationReasonCodes"
             FROM backlink_recommendation_generation_candidates
            WHERE id=$1`,
          [selfDomain.id],
        );
        const retainedEvidence = await client.query(
          `SELECT source.request_intent "requestIntent",
                  source.provider_outcome "providerOutcome",
                  source.discovered_url "discoveredUrl",
                  source.source_ref "sourceRef",
                  metric.value_state "metricValueState",
                  metric.metric_value "metricValue"
             FROM backlink_recommendation_generation_candidate_sources source
             CROSS JOIN backlink_recommendation_candidate_metric_snapshots
               metric
            WHERE source.generation_candidate_id=$1
              AND metric.generation_candidate_id=$2
              AND metric.artifact_ref='phase4:traffic-unavailable:1'`,
          [selfDomain.id, firstMaterialization.generationCandidateId],
        );
        const materialization = await client.query(
          `SELECT batch.status "batchStatus",
                  batch.request_intent "batchRequestIntent",
                  batch.source_types "batchSourceTypes",
                  batch.provider_request_fingerprints
                    "providerRequestFingerprints",
                  batch.provider_collected_at "batchProviderCollectedAt",
                  batch.paid_cost_micros "paidCostMicros",
                  candidate.static_assessment "staticAssessment",
                  candidate.gate_decision "gateDecision",
                  candidate.commercial_score "commercialScore",
                  candidate.score_model_version "scoreModelVersion",
                  candidate.state "candidateState",
                  candidate.provider_collected_at
                    "candidateProviderCollectedAt",
                  recommendation.pool_contract_version
                    "poolContractVersion",
                  recommendation.materialization_contract_version
                    "recommendationMaterializationVersion",
                  inventory.publication_status "publicationStatus",
                  inventory.fit_decision "fitDecision",
                  inventory.fit_score_model_version "fitScoreModelVersion",
                  link.materialization_contract_version
                    "linkMaterializationVersion",
                  link.idempotency_fingerprint "idempotencyFingerprint"
             FROM backlink_recommendation_generation_candidate_links link
             JOIN backlink_commercial_candidates candidate
               ON candidate.id=link.candidate_id
             JOIN backlink_commercial_discovery_batches batch
               ON batch.id=candidate.discovery_batch_id
             JOIN backlink_recommendations recommendation
               ON recommendation.id=link.recommendation_id
             JOIN backlink_recommendation_inventory inventory
               ON inventory.id=link.inventory_id
            WHERE link.generation_candidate_id=$1`,
          [firstMaterialization.generationCandidateId],
        );
        const legacyScore = await client.query(
          `SELECT count(*)::integer count
             FROM backlink_recommendation_scores
            WHERE recommendation_id=$1`,
          [firstMaterialization.recommendationId],
        );
        const admittedCountFunction = await client.query(
          `SELECT lower(pg_get_functiondef(procedure.oid)) definition
             FROM pg_proc procedure
            WHERE procedure.pronamespace='backlinks'::regnamespace
              AND procedure.proname=
                    'backlink_recommendation_generation_admitted_count'`,
        );
        return {
          admittedBefore,
          admittedAfterV1MutationAttempt,
          attemptedV1MutationError,
          admittedAfter,
          authority,
          exclusion,
          retainedEvidence,
          materialization,
          legacyScore,
          admittedCountFunction,
        };
      },
    );

    expect(inspected.admittedBefore.rows[0]?.count).toBe(
      projectA.candidateCount,
    );
    expect(inspected.attemptedV1MutationError).toMatch(
      /V2 canonical materialization is immutable/,
    );
    expect(inspected.admittedAfterV1MutationAttempt.rows[0]?.count).toBe(
      projectA.candidateCount,
    );
    expect(inspected.admittedAfter.rows[0]?.count).toBe(
      projectA.candidateCount,
    );
    expect(inspected.authority.rows[0]).toEqual({
      candidateCount: projectA.candidateCount + 1,
      admittedCount: projectA.candidateCount,
      excludedCount: 1,
    });
    expect(inspected.exclusion.rows[0]).toMatchObject({
      admissionState: "EXCLUDED",
      exclusionReasonCode: "SELF_DOMAIN",
      recommended: false,
      recommendationReasonCodes: ["SELF_DOMAIN"],
      exclusionEvidence: {
        contractVersion: "recommendation-pool-v2-domain-registry.v1",
        canonicalDomain: "project-0100.com",
        matchedObjectType: "PROJECT_CONTEXT",
        matchedObjectId: projectA.contextId,
      },
      decisionEvidence: {
        contractVersion: "recommendation-pool-admission.v2",
        historyRegistry: {
          reasonCode: "SELF_DOMAIN",
          objectType: "PROJECT_CONTEXT",
          objectId: projectA.contextId,
        },
      },
    });
    expect(inspected.retainedEvidence.rows[0]).toEqual({
      requestIntent: "DISCOVERY",
      providerOutcome: "SUCCEEDED",
      discoveredUrl: "https://project-0100.com/",
      sourceRef: "phase4:self-domain",
      metricValueState: "UNAVAILABLE",
      metricValue: null,
    });
    expect(inspected.materialization.rows[0]).toEqual({
      batchStatus: "completed",
      batchRequestIntent: "V2_MATERIALIZATION",
      batchSourceTypes: ["V2_CANONICAL_MATERIALIZATION"],
      providerRequestFingerprints: [],
      batchProviderCollectedAt: null,
      paidCostMicros: "0",
      staticAssessment: {
        assessment: "NOT_SCORED",
        contractVersion: "recommendation-pool-materialization.v2",
      },
      gateDecision: {
        contractVersion: "recommendation-pool-materialization.v2",
        decision: "NOT_APPLICABLE",
      },
      commercialScore: {
        contractVersion: "recommendation-pool-materialization.v2",
        score: null,
      },
      scoreModelVersion: "recommendation-pool-materialization.v2",
      candidateState: "v2_materialized",
      candidateProviderCollectedAt: null,
      poolContractVersion: "recommendation-pool.v2",
      recommendationMaterializationVersion:
        "recommendation-pool-materialization.v2",
      publicationStatus: "CONTACT_PENDING",
      fitDecision: "unassessed",
      fitScoreModelVersion: null,
      linkMaterializationVersion: "recommendation-pool-materialization.v2",
      idempotencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(inspected.legacyScore.rows[0]?.count).toBe(0);
    const admittedFunctionDefinition = String(
      inspected.admittedCountFunction.rows[0]?.definition ?? "",
    );
    expect(admittedFunctionDefinition).toContain(
      "backlink_recommendation_generation_candidates",
    );
    expect(admittedFunctionDefinition).toContain(
      "candidate.admission_state = 'admitted'",
    );
    expect(admittedFunctionDefinition).not.toContain(
      "backlink_commercial_candidates",
    );
    expect(admittedFunctionDefinition).not.toContain("commercial_score");
    expect(admittedFunctionDefinition).not.toContain("score_model_version");

    const wrongScope = await withBacklinkTenantTransaction(
      tenantPool,
      { ...scope, websiteProjectId: id(9999) },
      async (client) =>
        client.query(
          `SELECT
             (
               SELECT count(*)::integer
                 FROM backlink_recommendation_generation_candidates
             ) candidates,
             (
               SELECT count(*)::integer
                 FROM backlink_recommendation_generation_candidate_sources
             ) sources,
             (
               SELECT count(*)::integer
                 FROM backlink_recommendation_candidate_metric_snapshots
             ) metrics,
             (
               SELECT count(*)::integer
                 FROM backlink_recommendation_generation_candidate_links
             ) links`,
        ),
    );
    expect(wrongScope.rows[0]).toEqual({
      candidates: 0,
      sources: 0,
      metrics: 0,
      links: 0,
    });

    const phase9 = await admin.query(
      `SELECT
         backlinks.backlink_phase9_can_insert_v2_recommendation(
           to_jsonb(recommendation)
         ) valid,
         backlinks.backlink_phase9_can_insert_v2_recommendation(
           to_jsonb(recommendation) ||
             jsonb_build_object('input_pin_id',$2::text)
         ) invalid
       FROM backlinks.backlink_recommendations recommendation
       WHERE recommendation.id=$1`,
      [firstMaterialization.recommendationId, id(9997)],
    );
    expect(phase9.rows[0]).toEqual({
      valid: true,
      invalid: false,
    });

    const migrationBlocked = await admin.query(
      `SELECT count(*)::integer count
         FROM backlinks.backlink_recommendation_pool_project_contracts
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=ANY($3::uuid[])
          AND migration_state='MIGRATION_BLOCKED'`,
      [
        organizationId,
        workspaceId,
        [
          projectA.websiteProjectId,
          projectB.websiteProjectId,
          projectC.websiteProjectId,
        ],
      ],
    );
    expect(migrationBlocked.rows[0]?.count).toBe(0);
  }, 120_000);

  it("prevents previously admitted platform targets from entering new canonical batches", async () => {
    const project = buildProjectFixture(6000, 4, 1);
    await insertProjectFixture(admin, project, undefined, [
      "amazon.com", "old.reddit.com", "apple.com", "publisher-example.com",
    ]);
    const scope = { organizationId, workspaceId, websiteProjectId: project.websiteProjectId };
    await withBacklinkTenantTransaction(tenantPool, scope, async (client) =>
      createRecommendationPoolV2Repository(client).finalizeGeneration({
        ...scope,
        generationContractId: project.generationId,
        recommendationContextVersionId: project.contextId,
        visiblePoolGeneration: project.visiblePoolGeneration,
        inputPinId: project.inputPinId,
        jobId: "policy-finalize-job", workflowId: "policy-finalize-workflow", actorId,
        terminalReason: "PATHS_EXHAUSTED", totalSettledCostMicros: 0,
        hardCandidateLimit: 1000, rounds: [],
      }),
    );
    const items = await admin.query(
      "SELECT canonical_domain FROM backlinks.backlink_recommendation_release_batch_items WHERE website_project_id=$1",
      [project.websiteProjectId],
    );
    expect(items.rows.map((row) => row.canonical_domain)).toEqual(["publisher-example.com"]);
  });

  it.skipIf(!["live", "fixture"].includes(process.env.HYBRID_SUPPLY_ACCEPTANCE ?? ""))(
    "accepts encrypted Ahrefs credentials and real SQLite through the application supply path",
    async () => {
      const project = buildProjectFixture(8000, 0, 1);
      await insertProjectFixture(admin, project, undefined, undefined, "aiper.com");
      const scope = { organizationId, workspaceId, websiteProjectId: project.websiteProjectId };
      const input = {
        ...scope, generationContractId: project.generationId,
        recommendationContextVersionId: project.contextId,
        visiblePoolGeneration: 1, inputPinId: project.inputPinId,
        jobId: "hybrid-real-acceptance", workflowId: "hybrid-real-acceptance",
        actorId, terminalReason: "PATHS_EXHAUSTED" as const,
        totalSettledCostMicros: 0, hardCandidateLimit: 1000, rounds: [],
      };
      const realFetch = globalThis.fetch;
      let calls = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const target = new URL(String(url));
        expect(target.origin).toBe("https://api.ahrefs.com");
        expect(target.pathname).toBe("/v3/public/domain-rating-free");
        expect(target.searchParams.get("target")).toBe("aiper.com");
        expect(init?.method).toBe("GET");
        calls += 1;
        expect(calls).toBeLessThanOrEqual(3);
        return process.env.HYBRID_SUPPLY_ACCEPTANCE === "live"
          ? realFetch(url, init)
          : new Response(JSON.stringify({ domain_rating: { domain_rating: 61 } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
      });
      try {
        const guardedPrepare = createRecommendationHybridSupplyRuntime({
          pool: tenantPool, secretStoreRoot: process.env.PLATFORM_SECRET_STORE_ROOT ?? null,
        });
        if (guardedPrepare === undefined) throw new Error("REAL_ACCEPTANCE_LIBRARY_PATH_REQUIRED");
        const supply = await guardedPrepare(input);
        const callsAfterCacheMiss = calls;
        await guardedPrepare(input);
        expect(calls).toBe(callsAfterCacheMiss);
        const finalized = await withBacklinkTenantTransaction(tenantPool, scope, async (client) => {
          await supply(client);
          return createRecommendationPoolV2Repository(client).finalizeGeneration(input);
        });
        expect(calls).toBeGreaterThan(0);
        expect(finalized.batches.length).toBeGreaterThan(0);
        const cached = await admin.query(
          `SELECT target,domain_rating::float8 dr,failure_code
             FROM backlinks.backlink_project_domain_ratings WHERE website_project_id=$1`,
          [project.websiteProjectId],
        );
        expect(cached.rows[0]).toMatchObject({ target: "aiper.com", failure_code: null });
        expect(Number(cached.rows[0]?.dr)).toBeGreaterThanOrEqual(0);
        const callsBeforeReplay = calls;
        await guardedPrepare(input);
        expect(calls).toBe(callsBeforeReplay);

        // Only the contact completion boundary is a fixture; no crawler is dispatched.
        await admin.query(
          `UPDATE backlinks.backlink_recommendation_release_batch_items
              SET contact_terminal_reason_at_release='NO_CONTACT_FOUND',
                  contact_completed_at_release=statement_timestamp()
            WHERE website_project_id=$1`,
          [project.websiteProjectId],
        );
        await admin.query(
          `UPDATE backlinks.backlink_recommendation_release_batches
              SET state='AVAILABLE',contact_terminal_count=contact_total_count,
                  available_at=statement_timestamp(),updated_by=$2,version=version+1
            WHERE website_project_id=$1`,
          [project.websiteProjectId, actorId],
        );
        await admin.query(
          `UPDATE backlinks.backlink_recommendation_pool_project_contracts
              SET migration_state='V2_ACTIVE',activated_at=statement_timestamp(),
                  updated_by=$2,version=version+1 WHERE website_project_id=$1`,
          [project.websiteProjectId, actorId],
        );
        expect(await createRecommendationUserReleaseRepository(tenantPool)
          .publishInitial({ ...scope, actorId })).toMatchObject({ state: "PUBLISHED" });
        const query = createRecommendationFeedQuery(createRecommendationFeedRepository(tenantPool), {
          cursorSigningKey: "hybrid-real-acceptance-test",
        });
        const page = await query.list({
          tenant: createTenantContext({ organizationId, workspaceId }),
          actor: createActorContext({ userId: actorId, sessionId: "hybrid-real", roles: ["member"] }),
          project: createProjectContext({
            websiteProjectId: project.websiteProjectId, canonicalDomain: "aiper.com",
            locale: "en-US", countryCode: "US",
            profileVersionId: "site-profile-8000",
            promotionTargetVersionId: "target-8000",
          }),
        }, {});
        expect(page.items).toHaveLength(35);
        expect(page.items.every((item) => typeof item.metrics.ahrefsDr === "number")).toBe(true);
        expect(page.items.every((item) => item.metrics.dataForSeoRank === null)).toBe(true);
        console.info(JSON.stringify({
          acceptance: "isolated-ahrefs-library-application",
          ahrefsMode: process.env.HYBRID_SUPPLY_ACCEPTANCE,
          adapterCalls: calls, projectDr: cached.rows[0]?.dr,
          batchSizes: finalized.batches.map((batch) => batch.originalBatchSize),
          feedCount: page.items.length, totalCount: page.totalCount,
          contacts: "fixture", gmailSends: 0, dataForSeoCalls: 0,
        }));
      } finally {
        spy.mockRestore();
      }
    },
    90_000,
  );

  it("finalizes library-only candidates without fabricated DFS metrics", async () => {
    const project = buildProjectFixture(7000, 0, 1);
    await insertProjectFixture(admin, project);
    const scope = { organizationId, workspaceId, websiteProjectId: project.websiteProjectId };
    const lineage = {
      ...scope, generationContractId: project.generationId,
      recommendationContextVersionId: project.contextId,
      visiblePoolGeneration: 1, inputPinId: project.inputPinId,
    };
    const finalizeInput = {
      ...lineage, jobId: "library-finalize", workflowId: "library-finalize", actorId,
      terminalReason: "PATHS_EXHAUSTED" as const, totalSettledCostMicros: 0,
      hardCandidateLimit: 1000, rounds: [],
    };
    const first = await withBacklinkTenantTransaction(tenantPool, scope, async (client) => {
      const result = await createRecommendationPoolV2CandidateAdmissionService(
        createRecommendationPoolV2CandidateRepository(client),
      ).ingestArtifacts({
        ...lineage, projectDomain: "owner.com", market: "US", location: "US",
        language: "en", createdBy: actorId,
        observations: [{
          requestIntentId: "library-fixture", providerOutcome: "SUCCEEDED",
          artifact: {
            sourceType: "CURATED_RESOURCE_LIBRARY", endpoint: null, costMicros: 0,
            providerTaskIds: [], requestFingerprint: "library-fixture",
            responseSchemaVersion: "resource-library.sqlite.v1",
            collectedAt: new Date().toISOString(),
            candidates: [{
              canonicalDomain: "library-publisher.com",
              discoveryUrls: ["https://library-publisher.com"],
              backlinkPageEvidence: [], rank: null, traffic: null, backlinkCount: null,
              referringDomainCount: null, spamScore: null, countryCode: null,
              evidenceRefs: ["library-fixture"],
              resourceLibrary: { ahrefsDr: 0, monthlyTraffic: 12345,
                language: "English", categories: ["Home and Family"],
                categoryMatch: "RELATED", releaseBatchOrdinal: 1 },
            }],
          },
        }],
      });
      expect(result.admittedCount).toBe(1);
      return createRecommendationPoolV2Repository(client).finalizeGeneration(finalizeInput);
    });
    const replay = await withBacklinkTenantTransaction(tenantPool, scope, (client) =>
      createRecommendationPoolV2Repository(client).finalizeGeneration(finalizeInput));
    expect(replay.batches).toEqual(first.batches);
    const stored = await admin.query(`
      SELECT traffic_organic_etv,authority_rank,spam_score,traffic_snapshot,
             resource_library_snapshot,primary_category
        FROM backlinks.backlink_recommendation_release_batch_items
       WHERE website_project_id=$1`, [project.websiteProjectId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      traffic_organic_etv: null, authority_rank: null, spam_score: null,
      traffic_snapshot: { value: null, provider: "resource_library" },
      resource_library_snapshot: { ahrefsDr: 0, monthlyTraffic: 12345 },
      primary_category: "Home and Family",
    });
    await expect(admin.query(
      `UPDATE backlinks.backlink_recommendation_release_batch_items
          SET resource_library_snapshot='{"ahrefsDr":99}'::jsonb
        WHERE website_project_id=$1`,
      [project.websiteProjectId],
    )).rejects.toThrow();
  });

  it("persists deterministic canonical batches with complete lineage and one-ahead recovery", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectA.websiteProjectId,
    };
    const input = {
      ...scope,
      generationContractId: projectA.generationId,
      recommendationContextVersionId: projectA.contextId,
      visiblePoolGeneration: projectA.visiblePoolGeneration,
      inputPinId: projectA.inputPinId,
      jobId: "phase4-finalize-job",
      workflowId: "phase4-finalize-workflow",
      actorId,
      terminalReason: "PATHS_EXHAUSTED" as const,
      totalSettledCostMicros: 0,
      hardCandidateLimit: 1_000,
      rounds: [],
    };
    const finalize = () =>
      withBacklinkTenantTransaction(tenantPool, scope, async (client) =>
        createRecommendationPoolV2Repository(client).finalizeGeneration(input),
      );
    const metricCandidate = await admin.query(
      `SELECT id FROM backlinks.backlink_recommendation_generation_candidates
        WHERE website_project_id=$1 ORDER BY canonical_domain LIMIT 1`,
      [projectA.websiteProjectId],
    );
    const generationCandidateId = String(metricCandidate.rows[0]?.id);
    await withBacklinkTenantTransaction(tenantPool, scope, async (client) => {
      const repository = createRecommendationPoolV2CandidateRepository(client);
      for (const metricType of [
        "TRAFFIC_ORGANIC_ETV", "AUTHORITY_RANK", "SPAM_SCORE",
      ] as const) {
        for (const variant of ["missing", "wrong-market", "stale"] as const) {
          await repository.appendMetric({
            ...scope,
            generationCandidateId,
            metricType,
            provider: "fixture",
            endpoint: "phase4/canonical",
            market: variant === "wrong-market" ? "ZA" : "US",
            location: "United States",
            language: "en",
            requestIntent: "DISCOVERY",
            valueState: variant === "missing" ? "UNAVAILABLE" : "AVAILABLE",
            metricValue: variant === "missing" ? null : 99,
            artifactRef: `metric-regression:${metricType}:${variant}`,
            observedAt: new Date(Date.now() - (
              variant === "stale" ? 8 * 86_400_000 : 1000
            )).toISOString(),
            createdBy: actorId,
          });
        }
      }
    });
    const [first, replay] = await Promise.all([finalize(), finalize()]);

    expect(first).toEqual(replay);
    expect(first.effectiveUniqueCandidateCount).toBe(26);
    const releasedMetrics = await admin.query(
      `SELECT traffic_organic_etv::float8 traffic,authority_rank::float8 rank,
              spam_score::float8 spam,traffic_snapshot,rank_snapshot,spam_snapshot
         FROM backlinks.backlink_recommendation_release_batch_items
        WHERE generation_candidate_id=$1`,
      [generationCandidateId],
    );
    expect(releasedMetrics.rows[0]).toMatchObject({
      traffic: 100, rank: 10, spam: 0,
      traffic_snapshot: { value: 100, artifactRef: "phase4:TRAFFIC_ORGANIC_ETV:1" },
      rank_snapshot: { value: 10, artifactRef: "phase4:AUTHORITY_RANK:1" },
      spam_snapshot: { value: 0, artifactRef: "phase4:SPAM_SCORE:1" },
    });
    expect(
      first.batches.map(({ originalBatchSize }) => originalBatchSize),
    ).toEqual([13, 13]);

    await admin.query("BEGIN");
    try {
      const before = await admin.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_verify_cutover() AS state`,
      );
      await admin.query(
        `UPDATE backlinks.backlink_recommendation_pool_project_contracts
            SET migration_state='V2_ACTIVE',state_reason_codes='[]'::jsonb,
                activated_at=statement_timestamp(),updated_by=$4,version=version+1
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3`,
        [organizationId, workspaceId, projectA.websiteProjectId, actorId],
      );
      const after = await admin.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_verify_cutover() AS state`,
      );
      const beforeState = before.rows[0]?.state as Record<string, number>;
      const afterState = after.rows[0]?.state as Record<string, number>;
      expect(afterState.validV2ActiveProjectCount).toBe(beforeState.validV2ActiveProjectCount);
      expect(afterState.invalidV2ActiveProjectCount).toBe(Number(beforeState.invalidV2ActiveProjectCount) + 1);
    } finally {
      await admin.query("ROLLBACK");
    }

    const persisted = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      async (client) => {
        const batches = await client.query(
          `SELECT id,batch_ordinal "ordinal",original_batch_size "size",
                  order_fingerprint "fingerprint",state
             FROM backlink_recommendation_release_batches
            ORDER BY batch_ordinal`,
        );
        const items = await client.query(
          `SELECT batch_id "batchId",position,canonical_domain "domain",
                  candidate_id "candidateId",
                  recommendation_id "recommendationId",
                  prospect_id "prospectId",inventory_id "inventoryId",
                  generation_contract_id "generationId",
                  input_pin_id "inputPinId"
             FROM backlink_recommendation_release_batch_items
            ORDER BY canonical_domain`,
        );
        const recovery = await createRecommendationPoolV2Repository(
          client,
        ).loadCanonicalBatchPreparationRecovery({
          ...scope,
          actorId,
        });
        return { batches, items, recovery };
      },
    );
    expect(persisted.batches.rows).toHaveLength(2);
    expect(
      new Set(
        persisted.batches.rows.map(({ fingerprint }) => String(fingerprint)),
      ).size,
    ).toBe(2);
    expect(persisted.items.rows).toHaveLength(26);
    expect(
      new Set(persisted.items.rows.map(({ domain }) => String(domain))).size,
    ).toBe(26);
    expect(
      persisted.items.rows.every((row) =>
        [
          row.candidateId,
          row.recommendationId,
          row.prospectId,
          row.inventoryId,
          row.generationId,
          row.inputPinId,
        ].every((value) => typeof value === "string" && value.length > 0),
      ),
    ).toBe(true);
    expect(persisted.recovery).toMatchObject({
      status: "preparing",
      input: {
        batchIds: first.batches.slice(0, 2).map(({ batchId }) => batchId),
        preparationDeadlineAt: first.preparationDeadlineAt,
        publicationOutcome: "PARTIAL_EXHAUSTED",
      },
    });

    const wrongScopeCount = await withBacklinkTenantTransaction(
      tenantPool,
      { ...scope, websiteProjectId: id(9999) },
      async (client) =>
        client.query(
          `SELECT count(*)::integer count
             FROM backlink_recommendation_release_batches`,
        ),
    );
    expect(wrongScopeCount.rows[0]?.count).toBe(0);

    const selectedBatchIds = first.batches
      .slice(0, 2)
      .map(({ batchId }) => batchId);
    const preparationRequest = {
      ...scope,
      generationContractId: projectA.generationId,
      recommendationContextVersionId: projectA.contextId,
      visiblePoolGeneration: projectA.visiblePoolGeneration,
      inputPinId: projectA.inputPinId,
      actorId,
      batchIds: selectedBatchIds,
    };
    const prepareSelectedBatches = () =>
      withBacklinkTenantTransaction(tenantPool, scope, async (client) => {
        const repository = createRecommendationPoolV2Repository(client);
        const service = createRecommendationPoolV2ContactPreparationService({
          client,
          options: {
            maxPages: 4,
            maxDepth: 1,
            maxAttempts: 2,
            browserAllowed: false,
          },
          loadCanonicalContactSources: repository.loadCanonicalContactSources,
        });
        await service.prepareCanonicalBatches(preparationRequest);
      });
    const setProjectContractReasons = (reasonCodes: readonly string[]) =>
      admin.query(
        `UPDATE backlinks.backlink_recommendation_pool_project_contracts
            SET migration_state='MIGRATION_BLOCKED',
                state_reason_codes=$4::jsonb,
                updated_by=$5,
                version=version+1
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3`,
        [
          organizationId,
          workspaceId,
          projectA.websiteProjectId,
          JSON.stringify(reasonCodes),
          actorId,
        ],
      );
    const nativeGenerationVerification = await admin.query(
      `SELECT backlinks
         .backlink_recommendation_pool_v2_native_generation_verify()
         ->>'v1WritesFrozen' "v1WritesFrozen"`,
    );
    expect(nativeGenerationVerification.rows[0]?.v1WritesFrozen).toBe("true");

    await admin.query("BEGIN");
    try {
      await setProjectContractReasons([
        "V2_CANDIDATE_LINEAGE_INCOMPLETE",
        "UNRELATED_BLOCKER",
      ]);
      const repository = createRecommendationPoolV2Repository(admin);
      const service = createRecommendationPoolV2ContactPreparationService({
        client: admin,
        options: {
          maxPages: 4,
          maxDepth: 1,
          maxAttempts: 2,
          browserAllowed: false,
        },
        loadCanonicalContactSources: repository.loadCanonicalContactSources,
      });
      await expect(
        service.prepareCanonicalBatches(preparationRequest),
      ).rejects.toThrow(/batch coverage is incomplete/);
      const blockedPreparationWrites = await admin.query(
        `SELECT
           (
             SELECT count(*)::integer
               FROM backlinks.backlink_contact_enrichment_jobs
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
           ) "jobCount",
           (
             SELECT count(*)::integer
               FROM backlinks.backlink_outbox_events
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
                AND event_type='backlinks.contact-enrichment.requested.v1'
           ) "outboxCount"`,
        [organizationId, workspaceId, projectA.websiteProjectId],
      );
      expect(blockedPreparationWrites.rows[0]).toEqual({
        jobCount: 0,
        outboxCount: 0,
      });
    } finally {
      await admin.query("ROLLBACK");
    }

    await setProjectContractReasons(["V2_CANDIDATE_LINEAGE_INCOMPLETE"]);
    await prepareSelectedBatches();
    await prepareSelectedBatches();
    await admin.query("SET ROLE growthos_backlinks_writer");
    try {
      const directVisibility = await admin.query(
        `SELECT
           (SELECT count(*)::integer
              FROM backlinks.backlink_recommendation_pool_project_contracts)
             "contractCount",
           (SELECT count(*)::integer
              FROM backlinks.backlink_contact_enrichment_jobs)
             "contactJobCount"`,
      );
      expect(directVisibility.rows[0]).toEqual({
        contractCount: 0,
        contactJobCount: 0,
      });
      const recoveryScopes = await admin.query(
        `SELECT organization_id "organizationId",
                workspace_id "workspaceId",
                website_project_id "websiteProjectId"
           FROM backlinks.backlink_list_contact_enrichment_recovery_scopes(100)`,
      );
      expect(recoveryScopes.rows).toContainEqual({
        organizationId,
        workspaceId,
        websiteProjectId: projectA.websiteProjectId,
      });
    } finally {
      await admin.query("RESET ROLE");
    }
    const contactCounts = await admin.query(
      `SELECT
         count(*)::integer "jobCount",
         count(*) FILTER (
           WHERE recommendation_id <> ALL($4::uuid[])
         )::integer "nonSelectedJobCount"
       FROM backlinks.backlink_contact_enrichment_jobs
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3`,
      [
        organizationId,
        workspaceId,
        projectA.websiteProjectId,
        materializationsByProject
          .get(projectA.websiteProjectId)
          ?.slice(0, 26)
          .map(({ recommendationId }) => recommendationId) ?? [],
      ],
    );
    expect(contactCounts.rows[0]).toMatchObject({
      jobCount: 26,
      nonSelectedJobCount: 0,
    });
    const outboxCount = await admin.query(
      `SELECT count(*)::integer count
         FROM backlinks.backlink_outbox_events
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND event_type='backlinks.contact-enrichment.requested.v1'`,
      [organizationId, workspaceId, projectA.websiteProjectId],
    );
    expect(outboxCount.rows[0]?.count).toBe(26);

    const selectedRecommendations = await admin.query(
      `SELECT item.recommendation_id "recommendationId",
              batch.batch_ordinal "batchOrdinal"
         FROM backlinks.backlink_recommendation_release_batch_items item
         JOIN backlinks.backlink_recommendation_release_batches batch
           ON batch.id=item.batch_id
        WHERE item.batch_id=ANY($1::uuid[])
        ORDER BY batch.batch_ordinal,item.position`,
      [selectedBatchIds],
    );
    const pendingRecommendation = String(
      selectedRecommendations.rows.at(-1)?.recommendationId,
    );
    await admin.query(
      `UPDATE backlinks.backlink_contact_enrichment_jobs
          SET status=CASE WHEN recommendation_id=$4
            THEN 'retry_scheduled' ELSE 'no_contact_found' END,
              terminal_reason_code=CASE WHEN recommendation_id=$4
                THEN NULL ELSE 'NO_PUBLIC_EMAIL' END,
              completed_at=CASE WHEN recommendation_id=$4
                THEN NULL ELSE statement_timestamp() END,
              finished_at=CASE WHEN recommendation_id=$4
                THEN NULL ELSE statement_timestamp() END,
              retry_after=CASE WHEN recommendation_id=$4
                THEN statement_timestamp()+interval '1 hour' ELSE NULL END
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3`,
      [
        organizationId,
        workspaceId,
        projectA.websiteProjectId,
        pendingRecommendation,
      ],
    );
    const preparationInput = {
      ...scope,
      generationContractId: projectA.generationId,
      recommendationContextVersionId: projectA.contextId,
      visiblePoolGeneration: projectA.visiblePoolGeneration,
      inputPinId: projectA.inputPinId,
      actorId,
      batchIds: selectedBatchIds,
      preparationDeadlineAt: first.preparationDeadlineAt,
    };
    const inspected = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      async (client) =>
        createRecommendationPoolV2Repository(
          client,
        ).inspectCanonicalBatchPreparation(preparationInput),
    );
    expect(inspected).toMatchObject({
      state: "PREPARING",
      terminalBatchCount: 1,
      totalBatchCount: 2,
    });
    await expect(
      admin.query(
        `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',available_at=statement_timestamp(),
              contact_terminal_count=contact_total_count,version=version+1
        WHERE id=$1`,
        [selectedBatchIds[1]],
      ),
    ).rejects.toThrow(/AVAILABLE batch requires complete canonical items/);

    await expect(
      withBacklinkTenantTransaction(tenantPool, scope, async (client) =>
        createRecommendationPoolV2Repository(
          client,
        ).convergeCanonicalBatchPreparation({
          ...preparationInput,
          batchIds: selectedBatchIds.slice(1, 2),
          preparationDeadlineAt: "2026-08-29T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/RECOMMENDATION_POOL_V2_CONTACT_DEADLINE_MISMATCH/);
    const pendingAfterForgedDeadline = await admin.query(
      `SELECT status,terminal_reason_code "terminalReason"
         FROM backlinks.backlink_contact_enrichment_jobs
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND recommendation_id=$4`,
      [
        organizationId,
        workspaceId,
        projectA.websiteProjectId,
        pendingRecommendation,
      ],
    );
    expect(pendingAfterForgedDeadline.rows[0]).toMatchObject({
      status: "retry_scheduled",
      terminalReason: null,
    });

    // Exercise a later user cursor without changing the supersession fixture.
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL search_path = backlinks, pg_catalog");
      await admin.query(
        `UPDATE backlink_contact_enrichment_jobs
            SET status='no_contact_found',terminal_reason_code='NO_PUBLIC_EMAIL',
                completed_at=statement_timestamp(),finished_at=statement_timestamp(),
                retry_after=NULL
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND recommendation_id=$4`,
        [
          organizationId,
          workspaceId,
          projectA.websiteProjectId,
          pendingRecommendation,
        ],
      );
      const repository = createRecommendationPoolV2Repository(admin);
      expect(
        await repository.inspectCanonicalBatchPreparation(preparationInput),
      ).toMatchObject({ state: "AVAILABLE" });
      await admin.query(
        `INSERT INTO backlink_recommendation_user_publications (
           id,organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,visible_pool_generation,
           user_id,batch_id,published_by_command_id,created_by,updated_by
         ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'rolling-recovery-test',$6,$6)`,
        [
          organizationId,
          workspaceId,
          projectA.websiteProjectId,
          projectA.contextId,
          projectA.visiblePoolGeneration,
          actorId,
          selectedBatchIds[1],
        ],
      );
      await admin.query(
        `INSERT INTO backlink_recommendation_user_cursors (
           organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,visible_pool_generation,user_id,
           highest_published_batch_ordinal,current_batch_id,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,2,$7,$6)`,
        [
          organizationId,
          workspaceId,
          projectA.websiteProjectId,
          projectA.contextId,
          projectA.visiblePoolGeneration,
          actorId,
          selectedBatchIds[1],
        ],
      );
      expect(
        await repository.loadCanonicalBatchPreparationRecovery({
          ...scope,
          actorId,
        }),
      ).toMatchObject({
        status: "idle",
      });
      const cutoverBefore = await admin.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_verify_cutover()
          ->>'validV2ActiveProjectCount' AS count`,
      );
      await admin.query(
        `UPDATE backlink_recommendation_pool_project_contracts
            SET migration_state='V2_ACTIVE',state_reason_codes='[]'::jsonb,
                activated_at=statement_timestamp(),updated_by=$4,version=version+1
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3`,
        [organizationId, workspaceId, projectA.websiteProjectId, actorId],
      );
      const cutoverAfter = await admin.query(
        `SELECT backlinks.backlink_recommendation_pool_v2_verify_cutover()
          ->>'validV2ActiveProjectCount' AS count`,
      );
      expect(Number(cutoverAfter.rows[0]?.count)).toBe(
        Number(cutoverBefore.rows[0]?.count) + 1,
      );
      await admin.query(`SET LOCAL ROLE "${tenantRole}"`);
      const rollingScopes = await admin.query(
        `SELECT organization_id "organizationId",workspace_id "workspaceId",
                website_project_id "websiteProjectId"
           FROM backlinks.backlink_list_contact_enrichment_recovery_scopes(100)`,
      );
      expect(rollingScopes.rows).not.toContainEqual(scope);
    } finally {
      await admin.query("ROLLBACK");
    }

    await withBacklinkTenantTransaction(tenantPool, scope, async (client) =>
      createRecommendationPoolV2Repository(
        client,
      ).completeGenerationSupersession({
        ...scope,
        generationContractId: projectA.generationId,
        recommendationContextVersionId: projectA.contextId,
        visiblePoolGeneration: projectA.visiblePoolGeneration,
        inputPinId: projectA.inputPinId,
        actorId,
        supersession: {
          contractVersion: 2,
          organizationId,
          workspaceId,
          websiteProjectId: projectA.websiteProjectId,
          generationContractId: projectA.generationId,
          oldRecommendationContextVersionId: projectA.contextId,
          authoritativeRecommendationContextVersionId: id(9998),
          reason: "PROJECT_CONTEXT_SUPERSEDED",
        },
      }),
    );
    const superseded = await admin.query(
      `SELECT state,count(*)::integer count
         FROM backlinks.backlink_recommendation_release_batches
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
        GROUP BY state
        ORDER BY state`,
      [organizationId, workspaceId, projectA.websiteProjectId],
    );
    expect(superseded.rows).toEqual([
      { state: "AVAILABLE", count: 1 },
      { state: "SUPERSEDED", count: 1 },
    ]);
  }, 120_000);

  it("recovers and activates the newest preparing generation while the project contract still points to the old generation", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectC.websiteProjectId,
    };
    const jobId = id(2500);
    const oldGenerationId = id(1990);
    const oldGenerationProjection = `
      SELECT id,visible_pool_generation "visiblePoolGeneration",
             recommendation_context_version_id "contextId",
             input_pin_id "inputPinId",pool_contract_version "poolVersion",
             discovery_completed_at::text "discoveryCompletedAt",
             effective_unique_candidate_count "effectiveCandidateCount",
             canonical_order_fingerprint "canonicalOrderFingerprint",
             discovery_terminal_reason "discoveryTerminalReason"
        FROM backlinks.backlink_recommendation_generation_contracts
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND id=$4`;
    const activeBefore = await admin.query(
      `SELECT generation_contract_id "generationContractId",
              visible_pool_generation "visiblePoolGeneration"
         FROM backlinks.backlink_recommendation_pool_project_contracts
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3`,
      [organizationId, workspaceId, projectC.websiteProjectId],
    );
    expect(activeBefore.rows).toEqual([
      {
        generationContractId: oldGenerationId,
        visiblePoolGeneration: 1,
      },
    ]);
    const oldGenerationBefore = await admin.query(oldGenerationProjection, [
      organizationId,
      workspaceId,
      projectC.websiteProjectId,
      oldGenerationId,
    ]);
    expect(oldGenerationBefore.rows).toHaveLength(1);
    const domainRow = await admin.query(
      `SELECT canonical_domain FROM backlinks.backlink_recommendation_generation_candidates
        WHERE generation_contract_id=$1 LIMIT 1`,
      [projectC.generationId],
    );
    const canonicalDomain = String(domainRow.rows[0]?.canonical_domain);
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/referring_domains/live",
        intent: "DISCOVERY",
        sourceType: "USER_REFERRING_DOMAINS",
        request: { target: "owner.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1000,
      },
      collectedAt: observedAt,
      response: { tasks: [{ result: [{ items: [{
        domain: canonicalDomain, rank: 45, backlinks_spam_score: 0, etv: 321,
      }] }] }] },
    });
    await withBacklinkTenantTransaction(tenantPool, scope, async (client) => {
      const repository = createRecommendationPoolV2CandidateRepository(client);
      const origin = await repository.recordCandidate({
        ...scope,
        generationContractId: oldGenerationId,
        recommendationContextVersionId: projectC.contextId,
        visiblePoolGeneration: 1,
        inputPinId: projectC.inputPinId,
        canonicalDomain,
        admissionState: "ADMITTED",
        decisionEvidence: { passedRequiredExclusions: true },
        firstSeenRequestIntent: "DISCOVERY",
        recommended: true,
        recommendationReasonCodes: ["EVIDENCE_RELIABLE_METRIC"],
        firstSeenAt: observedAt,
        decidedAt: observedAt,
        createdBy: actorId,
      });
      const candidate = artifact.candidates[0];
      if (candidate === undefined || artifact.endpoint === null) {
        throw new Error("Expected normalized metric evidence.");
      }
      for (const [metricType, metricValue] of [
        ["TRAFFIC_ORGANIC_ETV", candidate.traffic],
        ["AUTHORITY_RANK", candidate.rank],
        ["SPAM_SCORE", candidate.spamScore],
      ] as const) {
        await repository.appendMetric({
          ...scope,
          generationCandidateId: origin.id,
          metricType,
          provider: "dataforseo",
          endpoint: artifact.endpoint,
          market: "US",
          location: "United States",
          language: "en",
          requestIntent: "DISCOVERY",
          valueState: "AVAILABLE",
          metricValue,
          artifactRef: artifact.requestFingerprint,
          observedAt,
          createdBy: actorId,
        });
      }
    });
    await admin.query(
      `INSERT INTO backlinks.backlink_jobs (
         id,organization_id,workspace_id,website_project_id,job_type,
         source_object_type,source_object_id,status,step,progress,
         workflow_id,correlation_id,result_summary,error,finished_at,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation_pool_v2_generation',
         'project-context-snapshot',$5,'waiting_provider','provider_request_authorizing',10,
         $6,$7,$8::jsonb,NULL,NULL,$9,$9
       )`,
      [
        jobId,
        organizationId,
        workspaceId,
        projectC.websiteProjectId,
        projectC.contextId,
        `phase4-recovery-${projectC.generationId}`,
        `phase4-recovery-${jobId}`,
        JSON.stringify({
          poolContractVersion: "recommendation-pool.v2",
          generationContractId: projectC.generationId,
          visiblePoolGeneration: projectC.visiblePoolGeneration,
          inputPinId: projectC.inputPinId,
          final: false,
          outcome: "RUNNING",
        }),
        actorId,
      ],
    );
    const finalization = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      async (client) =>
        createRecommendationPoolV2Repository(client).finalizeGeneration({
          ...scope,
          generationContractId: projectC.generationId,
          recommendationContextVersionId: projectC.contextId,
          visiblePoolGeneration: projectC.visiblePoolGeneration,
          inputPinId: projectC.inputPinId,
          jobId,
          workflowId: `phase4-recovery-${projectC.generationId}`,
          actorId,
          terminalReason: "PATHS_EXHAUSTED",
          totalSettledCostMicros: 0,
          hardCandidateLimit: 1_000,
          rounds: [],
        }),
    );
    expect(finalization.batches).toHaveLength(1);
    const reusedMetrics = await admin.query(
      `SELECT traffic_organic_etv::float8 traffic,authority_rank::float8 rank,
              spam_score::float8 spam,traffic_snapshot
         FROM backlinks.backlink_recommendation_release_batch_items
        WHERE generation_contract_id=$1`,
      [projectC.generationId],
    );
    expect(reusedMetrics.rows[0]).toMatchObject({
      traffic: 321, rank: 45, spam: 0,
      traffic_snapshot: { artifactRef: artifact.requestFingerprint, observedAt },
    });
    const preparingJob = await admin.query(
      `SELECT status,step,progress FROM backlinks.backlink_jobs WHERE id=$1`,
      [jobId],
    );
    expect(preparingJob.rows).toEqual([{
      status: "running",
      step: "canonical_batch_preparation",
      progress: 50,
    }]);
    const recoveryOptions = {
      maxPages: 4,
      maxDepth: 1,
      maxAttempts: 2,
      browserAllowed: false,
    };
    const firstRecovery = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          recoveryOptions,
          { ...scope, actorId: "phase4-recovery-worker" },
        ),
    );
    expect(firstRecovery).toMatchObject({
      status: "recovered",
      state: "PREPARING",
      workflowInput: {
        generationContractId: projectC.generationId,
        visiblePoolGeneration: projectC.visiblePoolGeneration,
        actorId,
      },
    });

    await admin.query(
      `UPDATE backlinks.backlink_contact_enrichment_jobs
          SET status='no_contact_found',
              terminal_reason_code='NO_PUBLIC_EMAIL',
              completed_at=statement_timestamp(),
              finished_at=statement_timestamp(),
              updated_by=$4
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3`,
      [organizationId, workspaceId, projectC.websiteProjectId, actorId],
    );
    const completedRecovery = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          recoveryOptions,
          { ...scope, actorId: "phase4-recovery-worker" },
        ),
    );
    expect(completedRecovery).toMatchObject({
      status: "recovered",
      state: "AVAILABLE",
      workflowInput: {
        generationContractId: projectC.generationId,
        visiblePoolGeneration: projectC.visiblePoolGeneration,
        actorId,
      },
    });

    const activated = await admin.query(
      `SELECT contract.generation_contract_id "generationContractId",
               contract.visible_pool_generation "visiblePoolGeneration",
               publication.user_id "userId",
               batch.state "batchState"
          FROM backlinks.backlink_recommendation_pool_project_contracts
            AS contract
         JOIN backlinks.backlink_recommendation_user_publications
           AS publication
           ON publication.organization_id=contract.organization_id
          AND publication.workspace_id=contract.workspace_id
           AND publication.website_project_id=contract.website_project_id
           AND publication.visible_pool_generation=
               contract.visible_pool_generation
          JOIN backlinks.backlink_recommendation_release_batches AS batch
            ON batch.organization_id=contract.organization_id
           AND batch.workspace_id=contract.workspace_id
          AND batch.website_project_id=contract.website_project_id
          AND batch.id=publication.batch_id
         WHERE contract.organization_id=$1 AND contract.workspace_id=$2
           AND contract.website_project_id=$3`,
      [organizationId, workspaceId, projectC.websiteProjectId],
    );
    expect(activated.rows).toEqual([
      {
        generationContractId: projectC.generationId,
        visiblePoolGeneration: projectC.visiblePoolGeneration,
        userId: actorId,
        batchState: "AVAILABLE",
      },
    ]);
    expect(projectC.visiblePoolGeneration).toBeGreaterThan(
      Number(activeBefore.rows[0]?.visiblePoolGeneration),
    );
    const oldGenerationAfter = await admin.query(oldGenerationProjection, [
      organizationId,
      workspaceId,
      projectC.websiteProjectId,
      oldGenerationId,
    ]);
    expect(oldGenerationAfter.rows).toEqual(oldGenerationBefore.rows);
    const terminalJob = await admin.query(
      `SELECT status,step,error,result_summary "resultSummary"
         FROM backlinks.backlink_jobs
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4`,
      [organizationId, workspaceId, projectC.websiteProjectId, jobId],
    );
    expect(terminalJob.rows).toEqual([
      {
        status: "success",
        step: "published",
        error: null,
        resultSummary: expect.objectContaining({
          final: true,
          outcome: "PARTIAL_EXHAUSTED",
          terminalReason: "PATHS_EXHAUSTED",
          discoveryTerminalReason: "PATHS_EXHAUSTED",
          releaseResult: "AVAILABLE",
          generationContractId: projectC.generationId,
          publishedGenerationContractId: projectC.generationId,
          publishedVisiblePoolGeneration: projectC.visiblePoolGeneration,
        }),
      },
    ]);
    expect(terminalJob.rows[0]?.resultSummary).not.toHaveProperty(
      "failureCode",
    );

    await admin.query(
      `UPDATE backlinks.backlink_jobs
          SET error=jsonb_build_object(
                'code','RECOMMENDATION_POOL_V2_WORKFLOW_FAILED'
              ),
              result_summary=result_summary ||
                jsonb_build_object(
                  'final',false,
                  'outcome','FAILED',
                  'failureCode','RECOMMENDATION_POOL_V2_WORKFLOW_FAILED'
                )
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4`,
      [organizationId, workspaceId, projectC.websiteProjectId, jobId],
    );
    const replayAfterActivation = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          recoveryOptions,
          { ...scope, actorId: "phase4-recovery-worker" },
        ),
    );
    expect(replayAfterActivation).toEqual({
      status: "idle",
    });
    const unchangedTerminalJob = await admin.query(
      `SELECT status,step,error,result_summary "resultSummary"
         FROM backlinks.backlink_jobs
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4`,
      [organizationId, workspaceId, projectC.websiteProjectId, jobId],
    );
    expect(unchangedTerminalJob.rows).toEqual([
      {
        status: "success",
        step: "published",
        error: expect.objectContaining({
          code: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
        }),
        resultSummary: expect.objectContaining({
          final: false,
          outcome: "FAILED",
          failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
        }),
      },
    ]);
  }, 120_000);

  it("reconciles native V2 public-email evidence on an already available batch without publishing through V1", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectE.websiteProjectId,
    };
    const batchId = id(4500);
    const itemId = id(4501);
    const contactBatchId = id(4502);
    const jobId = id(4503);
    const contactCandidateId = id(4504);
    const contactEvidenceId = id(4505);
    const materialized = materializationAt(projectE, 0);
    const canonicalDomain = "phase4-4000-01.com";
    const normalizedEmail = `editorial@${canonicalDomain}`;
    const contactUrl = `https://${canonicalDomain}/contact`;
    const metricSnapshot = JSON.stringify({
      value: null,
      provider: "fixture",
      endpoint: "phase4/canonical",
      market: "US",
      location: "United States",
      language: "en",
      observedAt: "2026-09-06T00:00:00.000Z",
      artifactRef: "phase4:available-contact-reconciliation",
    });

    await admin.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=1,
              canonical_batch_size=6,canonical_batch_count=1,
              canonical_order_fingerprint=$5,
              discovery_terminal_reason='PATHS_EXHAUSTED',
              discovery_completed_at=statement_timestamp()
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4`,
      [
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        projectE.generationId,
        "phase4-available-contact-reconciliation",
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id,organization_id,workspace_id,website_project_id,
         generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,input_pin_id,batch_ordinal,state,
         original_batch_size,selection_policy_version,order_fingerprint,
         contact_terminal_count,contact_total_count,preparation_started_at,
         deadline_at,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,1,'PREPARING',1,
         'recommendation-release-selection.v2',$9,0,1,
         statement_timestamp()-interval '2 hours',
         statement_timestamp()+interval '22 hours',$10,$10
       )`,
      [
        batchId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        projectE.generationId,
        projectE.contextId,
        projectE.visiblePoolGeneration,
        projectE.inputPinId,
        "phase4-available-contact-reconciliation",
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
         id,organization_id,workspace_id,website_project_id,batch_id,
         recommendation_context_version_id,visible_pool_generation,
         candidate_id,generation_candidate_id,recommendation_id,prospect_id,
         inventory_id,generation_contract_id,input_pin_id,
         pool_contract_version,canonical_domain,position,
         recommended,recommendation_reason_codes,recommendation_marker_version,
         traffic_snapshot,rank_snapshot,spam_snapshot,
         contact_terminal_reason_at_release,contact_completed_at_release,
         legacy_imported,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         'recommendation-pool.v2',$15,1,true,
         '["COMMERCIAL_FIT"]'::jsonb,'recommendation-marker.v2',
         $16::jsonb,$16::jsonb,$16::jsonb,
         'PUBLIC_EMAIL_FOUND',statement_timestamp(),false,$17
       )`,
      [
        itemId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        batchId,
        projectE.contextId,
        projectE.visiblePoolGeneration,
        materialized.candidateId,
        materialized.generationCandidateId,
        materialized.recommendationId,
        materialized.prospectId,
        materialized.inventoryId,
        projectE.generationId,
        projectE.inputPinId,
        canonicalDomain,
        metricSnapshot,
        actorId,
      ],
    );
    await admin.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',contact_terminal_count=1,
              available_at=statement_timestamp(),
              updated_at=statement_timestamp(),updated_by=$2,
              version=version+1
        WHERE id=$1`,
      [batchId, actorId],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_batches (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,status,completed_at,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,'completed',statement_timestamp(),$6,$6
       )`,
      [
        contactBatchId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        projectE.contextId,
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_jobs (
         id,organization_id,workspace_id,website_project_id,batch_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         root_url,status,attempt_count,max_attempts,max_pages,max_depth,
         browser_allowed,browser_used,pages_visited,candidate_count,
         evidence_count,finished_at,completed_at,terminal_reason_code,method,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',1,2,4,1,
         false,false,1,1,1,statement_timestamp(),statement_timestamp(),
         'PUBLIC_EMAIL_FOUND','static',$10,$10
       )`,
      [
        jobId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        contactBatchId,
        materialized.recommendationId,
        materialized.prospectId,
        projectE.contextId,
        `https://${canonicalDomain}`,
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_candidates (
         id,organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id,normalized_email,
         email_domain_ascii,domain_relation,syntax_validator_version,
         confidence,guessed,status,inferred_purpose,purpose_confidence,
         purpose_rule_version,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'same_registrable_domain',
         'email-syntax.v1',95,false,'candidate','editorial',95,
         'contact-purpose-rules.v1',$9,$9
       )`,
      [
        contactCandidateId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        materialized.prospectId,
        projectE.contextId,
        normalizedEmail,
        canonicalDomain,
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_evidence (
         id,organization_id,workspace_id,website_project_id,candidate_id,
         source_url,observed_at,extraction_method,evidence_snippet,
         parser_version,content_sha256,confidence,expires_at,created_by,
         rule_version,domain_relation
       ) VALUES (
         $1,$2,$3,$4,$5,$6,statement_timestamp(),'visible_text',$7,
         'contact-parser.v1',repeat('e',64),95,
         statement_timestamp()+interval '30 days',$8,
         'contact-extraction-rules.v1','same_registrable_domain'
       )`,
      [
        contactEvidenceId,
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        contactCandidateId,
        contactUrl,
        normalizedEmail,
        actorId,
      ],
    );

    await admin.query("SET ROLE growthos_backlinks_writer");
    try {
      const recoveryScopes = await admin.query(
        `SELECT organization_id "organizationId",
                workspace_id "workspaceId",
                website_project_id "websiteProjectId"
           FROM backlinks.backlink_list_contact_enrichment_recovery_scopes(100)`,
      );
      expect(recoveryScopes.rows).toContainEqual({
        organizationId,
        workspaceId,
        websiteProjectId: projectE.websiteProjectId,
      });
    } finally {
      await admin.query("RESET ROLE");
    }

    const recovered = await withBacklinkTenantTransaction(
      tenantPool,
      scope,
      (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          {
            maxPages: 4,
            maxDepth: 1,
            maxAttempts: 2,
            browserAllowed: false,
          },
          { ...scope, actorId: "phase4-contact-recovery-worker" },
        ),
    );
    expect(recovered).toMatchObject({
      status: "recovered",
      state: "AVAILABLE",
      batchIds: [batchId],
    });

    const reconciled = await admin.query(
      `SELECT item.contact_email_at_release "releaseEmail",
              item.contact_terminal_reason_at_release "releaseReason",
              inventory.publication_status "publicationStatus",
              inventory.fit_decision "fitDecision",
              inventory.fit_score_model_version "fitScoreModelVersion",
              inventory.contact_decision "contactDecision",
              inventory.contact_reason_code "contactReason",
              inventory.verified_public_email_count "verifiedEmailCount",
              inventory.default_contact_candidate_id "contactCandidateId",
              inventory.default_contact_source_url "contactSourceUrl",
              snapshot.contact_evidence_id "contactEvidenceId",
              candidate.state "candidateState",
              (
                SELECT count(*)::integer
                  FROM backlinks.backlink_contacts AS contact
                 WHERE contact.organization_id=item.organization_id
                   AND contact.workspace_id=item.workspace_id
                   AND contact.website_project_id=item.website_project_id
                   AND contact.prospect_id=item.prospect_id
              ) "activeContactCount",
              (
                SELECT count(*)::integer
                  FROM backlinks.backlink_recommendation_scores AS score
                 WHERE score.organization_id=item.organization_id
                   AND score.workspace_id=item.workspace_id
                   AND score.website_project_id=item.website_project_id
                   AND score.recommendation_id=item.recommendation_id
              ) "legacyScoreCount"
         FROM backlinks.backlink_recommendation_release_batch_items AS item
         JOIN backlinks.backlink_recommendation_inventory AS inventory
           ON inventory.id=item.inventory_id
         JOIN backlinks.backlink_commercial_candidates AS candidate
           ON candidate.id=item.candidate_id
         JOIN backlinks.backlink_contact_evidence_snapshots AS snapshot
           ON snapshot.id=inventory.contact_evidence_snapshot_id
        WHERE item.id=$1`,
      [itemId],
    );
    expect(reconciled.rows[0]).toEqual({
      releaseEmail: normalizedEmail,
      releaseReason: "PUBLIC_EMAIL_FOUND",
      publicationStatus: "CONTACT_PENDING",
      fitDecision: "unassessed",
      fitScoreModelVersion: null,
      contactDecision: "eligible",
      contactReason: "PUBLIC_EMAIL_FOUND",
      verifiedEmailCount: 1,
      contactCandidateId,
      contactSourceUrl: contactUrl,
      contactEvidenceId,
      candidateState: "v2_materialized",
      activeContactCount: 0,
      legacyScoreCount: 0,
    });
    await expect(
      admin.query(
        `UPDATE backlinks.backlink_recommendation_release_batch_items
            SET contact_email_at_release='other@phase4-4000-01.com'
          WHERE id=$1`,
        [itemId],
      ),
    ).rejects.toThrow(
      "Release item membership is immutable after insertion.",
    );

    await expect(
      withBacklinkTenantTransaction(tenantPool, scope, (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          {
            maxPages: 4,
            maxDepth: 1,
            maxAttempts: 2,
            browserAllowed: false,
          },
          { ...scope, actorId: "phase4-contact-recovery-worker" },
        ),
      ),
    ).resolves.toEqual({ status: "idle" });
    const snapshotCount = await admin.query(
      `SELECT count(*)::integer count
         FROM backlinks.backlink_contact_evidence_snapshots
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND recommendation_id=$4`,
      [
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        materialized.recommendationId,
      ],
    );
    expect(snapshotCount.rows[0]?.count).toBe(1);
  }, 120_000);

  it("converges an actually expired batch to COMPLETED_PARTIAL and AVAILABLE", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId: projectB.websiteProjectId,
    };
    const batchId = id(1500);
    const itemId = id(1501);
    const jobId = id(1502);
    const contactBatchId = id(1503);
    const materialized = materializationAt(projectB, 0);
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id,organization_id,workspace_id,website_project_id,
         generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,input_pin_id,batch_ordinal,state,
         original_batch_size,selection_policy_version,order_fingerprint,
         contact_terminal_count,contact_total_count,preparation_started_at,
         deadline_at,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,1,'PREPARING',1,
          'recommendation-release-selection.v2',$9,0,1,
          statement_timestamp()-interval '25 hours',
          statement_timestamp()-interval '1 hour',$10,$10
        )`,
      [
        batchId,
        organizationId,
        workspaceId,
        projectB.websiteProjectId,
        projectB.generationId,
        projectB.contextId,
        projectB.visiblePoolGeneration,
        projectB.inputPinId,
        "phase4-expired-fingerprint",
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
         id,organization_id,workspace_id,website_project_id,batch_id,
         recommendation_context_version_id,visible_pool_generation,
         candidate_id,generation_candidate_id,recommendation_id,prospect_id,
         inventory_id,generation_contract_id,input_pin_id,
         pool_contract_version,canonical_domain,position,
          recommended,recommendation_reason_codes,recommendation_marker_version,
          traffic_snapshot,rank_snapshot,spam_snapshot,legacy_imported,created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          'recommendation-pool.v2',$15,1,true,
          '["COMMERCIAL_FIT"]'::jsonb,'recommendation-marker.v2',
          $16::jsonb,$16::jsonb,$16::jsonb,false,$17
        )`,
      [
        itemId,
        organizationId,
        workspaceId,
        projectB.websiteProjectId,
        batchId,
        projectB.contextId,
        projectB.visiblePoolGeneration,
        materialized.candidateId,
        materialized.generationCandidateId,
        materialized.recommendationId,
        materialized.prospectId,
        materialized.inventoryId,
        projectB.generationId,
        projectB.inputPinId,
        "phase4-1000-01.com",
        JSON.stringify({
          value: null,
          provider: "fixture",
          endpoint: "phase4/canonical",
          market: "US",
          location: "United States",
          language: "en",
          observedAt: "2026-08-30T00:00:00.000Z",
          artifactRef: "phase4:expired",
        }),
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_batches (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,status,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,'running',$6,$6)`,
      [
        contactBatchId,
        organizationId,
        workspaceId,
        projectB.websiteProjectId,
        projectB.contextId,
        actorId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_enrichment_jobs (
         id,organization_id,workspace_id,website_project_id,batch_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         root_url,status,
         max_attempts,max_pages,max_depth,browser_allowed,retry_after,
          created_by,updated_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,'retry_scheduled',
          2,4,1,false,statement_timestamp()-interval '1 minute',$10,$10
        )`,
      [
        jobId,
        organizationId,
        workspaceId,
        projectB.websiteProjectId,
        contactBatchId,
        materialized.recommendationId,
        materialized.prospectId,
        projectB.contextId,
        "https://phase4-1000-01.com",
        actorId,
      ],
    );
    const persistedDeadline = await admin.query(
      `SELECT deadline_at "deadlineAt"
         FROM backlinks.backlink_recommendation_release_batches
        WHERE id=$1`,
      [batchId],
    );
    await withBacklinkTenantTransaction(tenantPool, scope, async (client) =>
      createRecommendationPoolV2Repository(
        client,
      ).convergeCanonicalBatchPreparation({
        ...scope,
        generationContractId: projectB.generationId,
        recommendationContextVersionId: projectB.contextId,
        visiblePoolGeneration: projectB.visiblePoolGeneration,
        inputPinId: projectB.inputPinId,
        actorId,
        batchIds: [batchId],
        preparationDeadlineAt: new Date(
          String(persistedDeadline.rows[0]?.deadlineAt),
        ).toISOString(),
      }),
    );
    const converged = await admin.query(
      `SELECT batch.state,item.contact_terminal_reason_at_release "reason",
              job.status,job.terminal_reason_code "jobReason"
         FROM backlinks.backlink_recommendation_release_batches batch
         JOIN backlinks.backlink_recommendation_release_batch_items item
           ON item.batch_id=batch.id
         JOIN backlinks.backlink_contact_enrichment_jobs job
           ON job.recommendation_id=item.recommendation_id
        WHERE batch.id=$1`,
      [batchId],
    );
    expect(converged.rows[0]).toMatchObject({
      state: "AVAILABLE",
      reason: "COMPLETED_PARTIAL",
      status: "partially_completed",
      jobReason: "COMPLETED_PARTIAL",
    });
    const providerUsage = await admin.query(
      `SELECT count(*)::integer count
         FROM backlinks.backlink_provider_usage_ledger
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=ANY($3::uuid[])`,
      [
        organizationId,
        workspaceId,
        [projectA.websiteProjectId, projectB.websiteProjectId],
      ],
    );
    expect(providerUsage.rows[0]?.count).toBe(0);
  }, 120_000);
});
