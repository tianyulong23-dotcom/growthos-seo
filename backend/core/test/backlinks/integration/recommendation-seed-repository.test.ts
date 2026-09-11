import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyBacklinksDeploymentManifest } from "../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";
import {
  createRecommendationPoolV2GenerationLaunchRepository,
  type RecommendationPoolV2GenerationLaunch,
} from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.js";
import { createRecommendationPoolV2Repository } from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.js";
import { createRecommendationSeedRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-seed.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { bindProviderOperationBudgetAuthorization } from "../../../src/modules/backlinks/domain/recommendations/provider-operation-budget.js";
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
type Pool = BacklinkTenantPool & {
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
const organizationId = "9a000000-0000-4000-8000-000000000001";
const workspaceId = "9a000000-0000-4000-8000-000000000002";
const actorId = "phase2-seed-member";
type ProjectFixture = Readonly<{
  websiteProjectId: string;
  contextId: string;
  profileId: string;
  pinId: string;
  v2PinId: string;
  generationId: string;
  contractId: string;
  blueprintId: string;
  suffix: string;
}>;

const projectA: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000003",
  contextId: "9a000000-0000-4000-8000-000000000004",
  profileId: "9a000000-0000-4000-8000-000000000005",
  pinId: "9a000000-0000-4000-8000-000000000006",
  v2PinId: "9a000000-0000-4000-8000-000000000010",
  generationId: "9a000000-0000-4000-8000-000000000007",
  contractId: "9a000000-0000-4000-8000-000000000008",
  blueprintId: "9a000000-0000-4000-8000-000000000009",
  suffix: "a",
};
const projectB: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000013",
  contextId: "9a000000-0000-4000-8000-000000000014",
  profileId: "9a000000-0000-4000-8000-000000000015",
  pinId: "9a000000-0000-4000-8000-000000000016",
  v2PinId: "9a000000-0000-4000-8000-000000000020",
  generationId: "9a000000-0000-4000-8000-000000000017",
  contractId: "9a000000-0000-4000-8000-000000000018",
  blueprintId: "9a000000-0000-4000-8000-000000000019",
  suffix: "b",
};
const projectC: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000023",
  contextId: "9a000000-0000-4000-8000-000000000024",
  profileId: "9a000000-0000-4000-8000-000000000025",
  pinId: "9a000000-0000-4000-8000-000000000026",
  v2PinId: "9a000000-0000-4000-8000-000000000030",
  generationId: "9a000000-0000-4000-8000-000000000027",
  contractId: "9a000000-0000-4000-8000-000000000028",
  blueprintId: "9a000000-0000-4000-8000-000000000029",
  suffix: "c",
};
const projectD: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000033",
  contextId: "9a000000-0000-4000-8000-000000000034",
  profileId: "9a000000-0000-4000-8000-000000000035",
  pinId: "9a000000-0000-4000-8000-000000000036",
  v2PinId: "9a000000-0000-4000-8000-000000000040",
  generationId: "9a000000-0000-4000-8000-000000000037",
  contractId: "9a000000-0000-4000-8000-000000000038",
  blueprintId: "9a000000-0000-4000-8000-000000000039",
  suffix: "d",
};
const projectE: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000043",
  contextId: "9a000000-0000-4000-8000-000000000044",
  profileId: "9a000000-0000-4000-8000-000000000045",
  pinId: "9a000000-0000-4000-8000-000000000046",
  v2PinId: "9a000000-0000-4000-8000-000000000050",
  generationId: "9a000000-0000-4000-8000-000000000047",
  contractId: "9a000000-0000-4000-8000-000000000048",
  blueprintId: "9a000000-0000-4000-8000-000000000049",
  suffix: "e",
};
const projectF: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000053",
  contextId: "9a000000-0000-4000-8000-000000000054",
  profileId: "9a000000-0000-4000-8000-000000000055",
  pinId: "9a000000-0000-4000-8000-000000000056",
  v2PinId: "9a000000-0000-4000-8000-000000000060",
  generationId: "9a000000-0000-4000-8000-000000000057",
  contractId: "9a000000-0000-4000-8000-000000000058",
  blueprintId: "9a000000-0000-4000-8000-000000000059",
  suffix: "f",
};
const projectG: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000063",
  contextId: "9a000000-0000-4000-8000-000000000064",
  profileId: "9a000000-0000-4000-8000-000000000065",
  pinId: "9a000000-0000-4000-8000-000000000066",
  v2PinId: "9a000000-0000-4000-8000-000000000070",
  generationId: "9a000000-0000-4000-8000-000000000067",
  contractId: "9a000000-0000-4000-8000-000000000068",
  blueprintId: "9a000000-0000-4000-8000-000000000069",
  suffix: "g",
};
const projectH: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000073",
  contextId: "9a000000-0000-4000-8000-000000000074",
  profileId: "9a000000-0000-4000-8000-000000000075",
  pinId: "9a000000-0000-4000-8000-000000000076",
  v2PinId: "9a000000-0000-4000-8000-000000000080",
  generationId: "9a000000-0000-4000-8000-000000000077",
  contractId: "9a000000-0000-4000-8000-000000000078",
  blueprintId: "9a000000-0000-4000-8000-000000000079",
  suffix: "h",
};
const projectI: ProjectFixture = {
  websiteProjectId: "9a000000-0000-4000-8000-000000000083",
  contextId: "9a000000-0000-4000-8000-000000000084",
  profileId: "9a000000-0000-4000-8000-000000000085",
  pinId: "9a000000-0000-4000-8000-000000000086",
  v2PinId: "9a000000-0000-4000-8000-000000000090",
  generationId: "9a000000-0000-4000-8000-000000000087",
  contractId: "9a000000-0000-4000-8000-000000000088",
  blueprintId: "9a000000-0000-4000-8000-000000000089",
  suffix: "i",
};

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
    targetRevision: "0093",
  });
}

async function insertProjectFixture(
  client: Client,
  project: ProjectFixture,
  withSeedFacts = true,
  withBlueprint = true,
): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id,organization_id,workspace_id,website_project_id,
       profile_version_id,promotion_target_version_id,
       keywords_and_topics,products_and_services,target_urls,
       target_audiences,partnership_goals,market,location,language,
       authorized_discovery_sources,immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'[]'::jsonb,
       $9::jsonb,$10::jsonb,'US','United States','en',
       '[]'::jsonb,$11,'phase2-seed-fixture'
     )`,
    [
      project.profileId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `profile-${project.suffix}`,
      `target-${project.suffix}`,
      JSON.stringify(
        withSeedFacts ? [`profile keyword ${project.suffix}`] : [],
      ),
      JSON.stringify(withSeedFacts ? [`product ${project.suffix}`] : []),
      JSON.stringify(withSeedFacts ? [`audience ${project.suffix}`] : []),
      JSON.stringify(withSeedFacts ? [`category ${project.suffix}`] : []),
      `profile-fingerprint-${project.suffix}`,
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
       $1,$2,$3,$4,3,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,
       'US','recommendation-qualification.v1',$8,'phase2-seed-fixture'
     )`,
    [
      project.pinId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `site-profile-${project.suffix}`,
      project.profileId,
      `target-${project.suffix}`,
      `pin-fingerprint-${project.suffix}`,
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
       $1,$2,$3,$4,3,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,
       'US','recommendation-pool-admission.v2',$8,'phase2-seed-fixture'
     )`,
    [
      project.v2PinId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `site-profile-${project.suffix}`,
      project.profileId,
      `target-${project.suffix}`,
      `v2-pin-fingerprint-${project.suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id,organization_id,workspace_id,website_project_id,snapshot_version,
       project_status,canonical_domain,locale,country_code,
       profile_version_id,promotion_target_version_id,products,keywords,
       target_audiences,created_by
     ) VALUES (
       $1,$2,$3,$4,3,'ACTIVE',$5,'en-US','US',$6,$7,
       $8::jsonb,$9::jsonb,$10::jsonb,'phase2-seed-fixture'
     )`,
    [
      project.contextId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      `project-${project.suffix}.example`,
      `site-profile-${project.suffix}`,
      `target-${project.suffix}`,
      JSON.stringify(
        withSeedFacts ? [`project product ${project.suffix}`] : [],
      ),
      JSON.stringify(
        withSeedFacts ? [`project keyword ${project.suffix}`] : [],
      ),
      JSON.stringify(
        withSeedFacts ? [`project audience ${project.suffix}`] : [],
      ),
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
       recommendation_marker_version,discovery_budget_policy_version
     ) VALUES (
       $1,$2,$3,$4,$5,1,$6,'recommendation-pool-admission.v2',
       'recommendation-pool-release-visibility.v2',
       'recommendation-pool-materialization.v2',
       'TARGET_MARKET','US','United States','en',2840,'en','{}'::jsonb,
       'recommendation-pool-worker.v2','phase2-seed-fixture',
       'recommendation-pool.v2','recommendation-seed.v2',
       'recommendation-release.v2','recommendation-marker.v2',
       'recommendation-discovery-budget.v2'
     )`,
    [
      project.generationId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.contextId,
      project.v2PinId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
       id,organization_id,workspace_id,website_project_id,
       pool_contract_version,migration_state,generation_contract_id,
       recommendation_context_version_id,visible_pool_generation,input_pin_id,
       created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,'recommendation-pool.v2','V2_READY',$5,$6,1,$7,
       'phase2-seed-fixture','phase2-seed-fixture'
     )`,
    [
      project.contractId,
      organizationId,
      workspaceId,
      project.websiteProjectId,
      project.generationId,
      project.contextId,
      project.v2PinId,
    ],
  );
  if (withBlueprint) {
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
         statement_timestamp(),'phase2-seed-fixture'
       )`,
      [
        project.blueprintId,
        organizationId,
        workspaceId,
        project.websiteProjectId,
        project.contextId,
      ],
    );
  }
}

describe("Phase 2 recommendation seed repository", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: Pool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await installMigrations(client);
    await insertProjectFixture(client, projectA);
    await insertProjectFixture(client, projectB);
    await insertProjectFixture(client, projectC, false);
    await insertProjectFixture(client, projectD, false);
    await insertProjectFixture(client, projectE, false);
    await insertProjectFixture(client, projectF, false, false);
    await insertProjectFixture(client, projectG);
    await insertProjectFixture(client, projectH);
    await insertProjectFixture(client, projectI);
    pool = new PgPool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,public",
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("persists scoped seed lineage and atomically replays concurrent requests", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const request = {
      organizationId,
      workspaceId,
      websiteProjectId: projectA.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED" as const,
      idempotencyKey: "phase2-seed-concurrent",
      requestHash: "phase2-seed-concurrent-hash",
      requestId: "phase2-seed-request",
      userSeeds: [
        { kind: "KEYWORD" as const, value: "Project Keyword A" },
        { kind: "KEYWORD" as const, value: "project keyword a" },
      ],
      systemCandidates: [],
    };
    const results = await Promise.all([
      repository.prepare(request),
      repository.prepare(request),
    ]);

    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0]?.state).toBe("READY");
    expect(results[0]?.snapshot).toMatchObject({
      projectContextSnapshotId: projectA.contextId,
      outreachProfileVersionId: projectA.profileId,
      outreachProfileFingerprint: "profile-fingerprint-a",
      market: "US",
      language: "en",
    });
    expect(
      results[0]?.seeds.filter(
        ({ normalizedValue }) => normalizedValue === "project keyword a",
      ),
    ).toHaveLength(1);
    expect(
      results[0]?.seeds.find(
        ({ normalizedValue }) => normalizedValue === "project keyword a",
      ),
    ).toMatchObject({
      source: "USER_INPUT",
      validationStatus: "VERIFIED",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ evidenceType: "USER_INPUT" }),
        expect.objectContaining({ evidenceType: "OUTREACH_PROFILE" }),
      ]),
    });
    expect(results[0]?.blueprintSeedReferences.length).toBe(
      results[0]?.seeds.length,
    );
    const exactBlueprintId =
      results[0]?.blueprintSeedReferences[0]?.blueprintId;
    expect(exactBlueprintId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      results[0]?.blueprintSeedReferences.every(
        (reference) =>
          reference.blueprintId === exactBlueprintId &&
          results[0]?.seeds.some(
            (seed) =>
              seed.id === reference.seedId &&
              seed.seedFingerprint === reference.seedFingerprint,
          ),
      ),
    ).toBe(true);

    const persisted = await client.query(
      `SELECT count(*)::integer AS count,
              count(DISTINCT normalized_value)::integer AS "distinctValues"
         FROM backlinks.backlink_commercial_discovery_seeds
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_contract_id=$4`,
      [
        organizationId,
        workspaceId,
        projectA.websiteProjectId,
        projectA.generationId,
      ],
    );
    expect(persisted.rows).toEqual([
      {
        count: results[0]?.seeds.length,
        distinctValues: results[0]?.seeds.length,
      },
    ]);

    await expect(
      repository.prepare({
        ...request,
        requestHash: "different-request-hash",
        userSeeds: [{ kind: "KEYWORD", value: "Different value" }],
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  }, 30_000);

  it("keeps project facts isolated and rejects unknown project scope", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const other = await repository.validate({
      organizationId,
      workspaceId,
      websiteProjectId: projectB.websiteProjectId,
      actorId,
      userSeeds: [],
      systemCandidates: [],
    });
    expect(other.state).toBe("READY");
    expect(
      other.seeds.every((seed) => !seed.normalizedValue.endsWith(" a")),
    ).toBe(true);

    await expect(
      repository.validate({
        organizationId,
        workspaceId,
        websiteProjectId: "9a000000-0000-4000-8000-000000000099",
        actorId,
        userSeeds: [],
        systemCandidates: [],
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  });

  it("rejects cross-tenant and cross-workspace seed reads", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const baseInput = {
      organizationId,
      workspaceId,
      websiteProjectId: projectA.websiteProjectId,
      actorId,
      userSeeds: [],
      systemCandidates: [],
    };

    await expect(
      repository.validate({
        ...baseInput,
        organizationId: "9a000000-0000-4000-8000-000000000091",
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await expect(
      repository.validate({
        ...baseInput,
        workspaceId: "9a000000-0000-4000-8000-000000000092",
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  });

  it("reuses persisted user seeds for an empty pre-task fallback", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const initial = await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectC.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-persisted-user-seed",
      requestHash: "phase2-persisted-user-seed-hash",
      requestId: "phase2-persisted-user-seed-request",
      userSeeds: [{ kind: "KEYWORD", value: "Durable User Topic" }],
      systemCandidates: [],
    });
    const persistedSeed = initial.seeds.find(
      ({ normalizedValue }) => normalizedValue === "durable user topic",
    );
    const exactBlueprintId = initial.blueprintSeedReferences[0]?.blueprintId;
    expect(persistedSeed).toBeDefined();
    expect(exactBlueprintId).toMatch(/^[0-9a-f-]{36}$/);

    const prepared = await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectC.websiteProjectId,
      actorId,
      trigger: "PRE_TASK_FALLBACK",
      idempotencyKey: "phase2-persisted-user-seed-pre-task",
      requestHash: "phase2-persisted-user-seed-pre-task-hash",
      requestId: "phase2-persisted-user-seed-pre-task-request",
      userSeeds: [],
      systemCandidates: [],
    });

    expect(prepared).toMatchObject({
      state: "READY",
      reasonCodes: [],
    });
    expect(prepared.seeds).toEqual([persistedSeed]);
    expect(prepared.blueprintSeedReferences).toEqual([
      expect.objectContaining({
        blueprintId: exactBlueprintId,
        seedId: persistedSeed?.id,
        seedFingerprint: persistedSeed?.seedFingerprint,
        seedOrdinal: 1,
      }),
    ]);
  });

  it("preserves user provenance when user input matches an existing fallback", async () => {
    const repository = createRecommendationSeedRepository(pool);
    await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectD.websiteProjectId,
      actorId,
      trigger: "PRE_TASK_FALLBACK",
      idempotencyKey: "phase2-system-fallback-first",
      requestHash: "phase2-system-fallback-first-hash",
      requestId: "phase2-system-fallback-first-request",
      userSeeds: [],
      systemCandidates: [
        {
          kind: "KEYWORD",
          value: "Shared Canonical Topic",
          source: "SYSTEM_FALLBACK",
          evidenceRefs: [
            {
              evidenceType: "PROJECT_CONTEXT",
              recordId: projectD.contextId,
              field: "products",
            },
          ],
          confidenceBand: "MEDIUM",
        },
      ],
    });

    const prepared = await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectD.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-user-provenance-second",
      requestHash: "phase2-user-provenance-second-hash",
      requestId: "phase2-user-provenance-second-request",
      userSeeds: [{ kind: "KEYWORD", value: "shared canonical topic" }],
      systemCandidates: [],
    });
    const seedRow = await client.query(
      `SELECT source,evidence_refs "evidenceRefs"
         FROM backlinks.backlink_commercial_discovery_seeds
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_contract_id=$4
          AND seed_kind='KEYWORD'
          AND normalized_value='shared canonical topic'`,
      [
        organizationId,
        workspaceId,
        projectD.websiteProjectId,
        projectD.generationId,
      ],
    );
    const provenanceRows = await client.query(
      `SELECT id,asserted_source "source",
              asserted_evidence_refs "evidenceRefs",
              assertion_fingerprint "assertionFingerprint"
         FROM backlinks.backlink_commercial_discovery_seed_provenance_assertions
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_contract_id=$4
        ORDER BY created_at,id`,
      [
        organizationId,
        workspaceId,
        projectD.websiteProjectId,
        projectD.generationId,
      ],
    );

    expect(prepared.seeds).toEqual([
      expect.objectContaining({
        source: "USER_INPUT",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ evidenceType: "USER_INPUT" }),
          expect.objectContaining({ evidenceType: "PROJECT_CONTEXT" }),
        ]),
      }),
    ]);
    expect(seedRow.rows).toEqual([
      expect.objectContaining({
        source: "SYSTEM_FALLBACK",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ evidenceType: "PROJECT_CONTEXT" }),
        ]),
      }),
    ]);
    expect(provenanceRows.rows).toEqual([
      expect.objectContaining({
        source: "SYSTEM_FALLBACK",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ evidenceType: "PROJECT_CONTEXT" }),
        ]),
        assertionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        source: "USER_INPUT",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ evidenceType: "USER_INPUT" }),
        ]),
        assertionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectD.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-user-provenance-third",
      requestHash: "phase2-user-provenance-third-hash",
      requestId: "phase2-user-provenance-third-request",
      userSeeds: [{ kind: "KEYWORD", value: "shared canonical topic" }],
      systemCandidates: [],
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::integer count
             FROM backlinks.backlink_commercial_discovery_seed_provenance_assertions
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND generation_contract_id=$4`,
          [
            organizationId,
            workspaceId,
            projectD.websiteProjectId,
            projectD.generationId,
          ],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    const userAssertionId = provenanceRows.rows.find(
      ({ source }) => source === "USER_INPUT",
    )?.id;
    expect(userAssertionId).toEqual(expect.any(String));
    await expect(
      client.query(
        `UPDATE backlinks.backlink_commercial_discovery_seed_provenance_assertions
            SET asserted_raw_value='mutated'
          WHERE id=$1`,
        [userAssertionId],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      client.query(
        `DELETE FROM backlinks.backlink_commercial_discovery_seed_provenance_assertions
          WHERE id=$1`,
        [userAssertionId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("retains superseded rows but excludes them from the current effective set", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const initial = await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectE.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-supersession-old",
      requestHash: "phase2-supersession-old-hash",
      requestId: "phase2-supersession-old-request",
      userSeeds: [{ kind: "KEYWORD", value: "Old User Topic" }],
      systemCandidates: [],
    });
    const oldSeed = initial.seeds[0];
    const exactBlueprintId = initial.blueprintSeedReferences[0]?.blueprintId;
    expect(oldSeed).toBeDefined();
    expect(exactBlueprintId).toMatch(/^[0-9a-f-]{36}$/);

    const prepared = await repository.prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectE.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-supersession-new",
      requestHash: "phase2-supersession-new-hash",
      requestId: "phase2-supersession-new-request",
      userSeeds: [
        {
          kind: "KEYWORD",
          value: "New User Topic",
          supersedesSeedId: oldSeed?.id,
        },
      ],
      systemCandidates: [],
    });
    const persisted = await client.query(
      `SELECT id,normalized_value "normalizedValue"
         FROM backlinks.backlink_commercial_discovery_seeds
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_contract_id=$4
        ORDER BY created_at,id`,
      [
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        projectE.generationId,
      ],
    );

    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldSeed?.id,
          normalizedValue: "old user topic",
        }),
        expect.objectContaining({ normalizedValue: "new user topic" }),
      ]),
    );
    expect(prepared.seeds).toEqual([
      expect.objectContaining({
        normalizedValue: "new user topic",
        supersedesSeedId: oldSeed?.id,
      }),
    ]);
    expect(prepared).toMatchObject({
      state: "INPUT_REQUIRED",
      reasonCodes: ["BLUEPRINT_SEED_REBIND_REQUIRED"],
      blueprintSeedReferences: [],
    });
    const immutableAssignments = await client.query(
      `SELECT seed_id "seedId",seed_fingerprint "seedFingerprint",
              seed_ordinal "seedOrdinal"
         FROM backlinks.backlink_commercial_blueprint_seeds
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND blueprint_id=$4
        ORDER BY seed_ordinal`,
      [
        organizationId,
        workspaceId,
        projectE.websiteProjectId,
        exactBlueprintId,
      ],
    );
    expect(immutableAssignments.rows).toEqual([
      expect.objectContaining({
        seedId: oldSeed?.id,
        seedFingerprint: oldSeed?.seedFingerprint,
        seedOrdinal: 1,
      }),
    ]);
  });

  it("creates or reuses an exact V2 Blueprint when the project has no prior Blueprint", async () => {
    const repository = createRecommendationSeedRepository(pool);
    const requests = [1, 2].map((attempt) =>
      repository.prepare({
        organizationId,
        workspaceId,
        websiteProjectId: projectF.websiteProjectId,
        actorId,
        trigger: "USER_TRIGGERED" as const,
        idempotencyKey: `phase2-v2-blueprint-${attempt}`,
        requestHash: `phase2-v2-blueprint-hash-${attempt}`,
        requestId: `phase2-v2-blueprint-request-${attempt}`,
        userSeeds: [
          { kind: "KEYWORD" as const, value: "Exact V2 Seed Snapshot" },
        ],
        systemCandidates: [],
      }),
    );

    const prepared = await Promise.all(requests);
    expect(prepared.map(({ state }) => state)).toEqual(["READY", "READY"]);
    expect(
      new Set(
        prepared.flatMap(({ blueprintSeedReferences }) =>
          blueprintSeedReferences.map(({ blueprintId }) => blueprintId),
        ),
      ).size,
    ).toBe(1);
    const blueprints = await client.query(
      `SELECT id,seed_snapshot_fingerprint "seedSnapshotFingerprint"
         FROM backlinks.backlink_commercial_discovery_blueprints
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3`,
      [organizationId, workspaceId, projectF.websiteProjectId],
    );
    expect(blueprints.rows).toEqual([
      expect.objectContaining({
        seedSnapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it("recovers only the exact frozen candidate-lineage blocker without invalid-state writes", async () => {
    const setBlockedState = async (
      project: ProjectFixture,
      reasonCodes: readonly string[],
    ) => {
      await client.query("SET session_replication_role = replica");
      try {
        await client.query(
          `UPDATE backlinks.backlink_recommendation_pool_project_contracts
              SET migration_state='MIGRATION_BLOCKED',
                  state_reason_codes=$4::jsonb
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3`,
          [
            organizationId,
            workspaceId,
            project.websiteProjectId,
            JSON.stringify(reasonCodes),
          ],
        );
      } finally {
        await client.query("SET session_replication_role = origin");
      }
    };
    const mutationCounts = (project: ProjectFixture) =>
      client.query(
        `SELECT
           (
             SELECT count(*)::integer
               FROM backlinks.backlink_generation_input_pins
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
           ) "inputPins",
           (
             SELECT count(*)::integer
               FROM backlinks.backlink_recommendation_generation_contracts
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
           ) generations,
           (
             SELECT count(*)::integer
               FROM backlinks.backlink_jobs
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
           ) jobs`,
        [organizationId, workspaceId, project.websiteProjectId],
      );
    const requestFor = (project: ProjectFixture) => ({
      organizationId,
      workspaceId,
      websiteProjectId: project.websiteProjectId,
      actorId,
      requestId: `phase2-v2-recovery-${project.suffix}`,
      idempotencyKey: `phase2-v2-recovery-${project.suffix}`,
      providerBudgetAuthorization: bindProviderOperationBudgetAuthorization(
        {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 1,
          maxCostMicros: 1_000_000,
        },
        { authorizedBy: actorId },
      ),
    });
    const repository =
      createRecommendationPoolV2GenerationLaunchRepository(pool);

    const baselineSeeds = await createRecommendationSeedRepository(
      pool,
    ).prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectG.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-v2-recovery-baseline-seeds-g",
      requestHash: "phase2-v2-recovery-baseline-seeds-hash-g",
      requestId: "phase2-v2-recovery-baseline-seeds-request-g",
      userSeeds: [],
      systemCandidates: [],
    });
    expect(baselineSeeds.state).toBe("READY");
    await setBlockedState(projectG, ["V2_CANDIDATE_LINEAGE_INCOMPLETE"]);
    const recovered = await repository.stage(requestFor(projectG));
    const prepared = await createRecommendationSeedRepository(pool).prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectG.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-v2-recovery-seeds-g",
      requestHash: "phase2-v2-recovery-seeds-hash-g",
      requestId: "phase2-v2-recovery-seeds-request-g",
      userSeeds: [],
      systemCandidates: [],
      targetGenerationContractId: recovered.generationContractId,
    });
    expect(prepared.state).toBe("READY");
    await expect(
      withBacklinkTenantTransaction(
        pool,
        {
          organizationId,
          workspaceId,
          websiteProjectId: projectG.websiteProjectId,
        },
        (transaction) =>
          createRecommendationPoolV2Repository(transaction).loadGeneration({
            organizationId,
            workspaceId,
            websiteProjectId: projectG.websiteProjectId,
            generationContractId: recovered.generationContractId,
            recommendationContextVersionId:
              recovered.recommendationContextVersionId,
            visiblePoolGeneration: recovered.visiblePoolGeneration,
            inputPinId: recovered.inputPinId,
            jobId: recovered.jobId,
            workflowId: recovered.workflowId,
            actorId,
            rounds: [],
          }),
      ),
    ).resolves.toEqual({ status: "ready" });

    await setBlockedState(projectH, [
      "V2_CANDIDATE_LINEAGE_INCOMPLETE",
      "PROJECT_INPUT_REQUIRED",
    ]);
    const extraReasonBefore = await mutationCounts(projectH);
    await expect(repository.stage(requestFor(projectH))).rejects.toThrow(
      "RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE",
    );
    const extraReasonAfter = await mutationCounts(projectH);
    expect(extraReasonAfter.rows).toEqual(extraReasonBefore.rows);

    await setBlockedState(projectI, ["V2_CANDIDATE_LINEAGE_INCOMPLETE"]);
    const freeze = await client.query(
      `SELECT control_key "controlKey",state,
              frozen_by_run_id "frozenByRunId",
              frozen_at "frozenAt",frozen_by "frozenBy"
         FROM backlinks.backlink_recommendation_pool_v2_cutover_control
        WHERE control_key='GLOBAL'`,
    );
    expect(freeze.rows).toHaveLength(1);
    await client.query("SET session_replication_role = replica");
    try {
      await client.query(
        `DELETE FROM backlinks.backlink_recommendation_pool_v2_cutover_control
          WHERE control_key='GLOBAL'`,
      );
    } finally {
      await client.query("SET session_replication_role = origin");
    }
    try {
      const unfrozenBefore = await mutationCounts(projectI);
      await expect(repository.stage(requestFor(projectI))).rejects.toThrow(
        "RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE",
      );
      const unfrozenAfter = await mutationCounts(projectI);
      expect(unfrozenAfter.rows).toEqual(unfrozenBefore.rows);
    } finally {
      const control = freeze.rows[0];
      await client.query("SET session_replication_role = replica");
      try {
        await client.query(
          `INSERT INTO
             backlinks.backlink_recommendation_pool_v2_cutover_control (
               control_key,state,frozen_by_run_id,frozen_at,frozen_by
             ) VALUES ($1,$2,$3,$4,$5)`,
          [
            control?.controlKey,
            control?.state,
            control?.frozenByRunId,
            control?.frozenAt,
            control?.frozenBy,
          ],
        );
      } finally {
        await client.query("SET session_replication_role = origin");
      }
    }
  }, 30_000);

  it("stages and replays a native V2 generation in PostgreSQL", async () => {
    const migratedGenerationId = "9a000000-0000-4000-8000-000000000011";
    await client.query("SET session_replication_role = replica");
    try {
      await client.query(
        `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
           id,organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,visible_pool_generation,
           input_pin_id,qualification_contract_version,
           visibility_contract_version,score_model_version,metric_scope,
           market,location,language,traffic_location_code,
           traffic_language_code,request_fingerprints,
           creator_worker_contract_version,created_by,pool_contract_version,
           seed_contract_version,release_contract_version,
           recommendation_marker_version,discovery_budget_policy_version
         ) VALUES (
           $1,$2,$3,$4,$5,2,$6,'recommendation-qualification.v1',
           'recommendation-visibility.v1','recommendation-commercial-fit.v4',
           'TARGET_MARKET','US','United States','en',2840,'en',
           '{}'::jsonb,'recommendation-qualification.v1',
           'phase2-migrated-fixture','recommendation-pool.v1',
           'recommendation-seed.v1','recommendation-release.v1',
           'recommendation-marker.v1','recommendation-discovery-budget.v1'
          )`,
        [
          migratedGenerationId,
          organizationId,
          workspaceId,
          projectB.websiteProjectId,
          projectB.contextId,
          projectB.pinId,
        ],
      );
      await client.query(
        `UPDATE backlinks.backlink_recommendation_pool_project_contracts
            SET generation_contract_id=$4,visible_pool_generation=2,
                input_pin_id=$5,updated_by='phase2-migrated-fixture'
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3`,
        [
          organizationId,
          workspaceId,
          projectB.websiteProjectId,
          migratedGenerationId,
          projectB.pinId,
        ],
      );
    } finally {
      await client.query("SET session_replication_role = origin");
    }

    const seedRepository = createRecommendationSeedRepository(pool);
    const preflight = await seedRepository.validate({
      organizationId,
      workspaceId,
      websiteProjectId: projectB.websiteProjectId,
      actorId,
      userSeeds: [],
      systemCandidates: [],
    });
    expect(preflight.state).toBe("READY");
    await expect(
      seedRepository.prepare({
        organizationId,
        workspaceId,
        websiteProjectId: projectB.websiteProjectId,
        actorId,
        trigger: "USER_TRIGGERED",
        idempotencyKey: "phase2-migrated-target-rejected",
        requestHash: "phase2-migrated-target-rejected-hash",
        requestId: "phase2-migrated-target-rejected-request",
        targetGenerationContractId: migratedGenerationId,
        userSeeds: [],
        systemCandidates: [],
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });

    const repository =
      createRecommendationPoolV2GenerationLaunchRepository(pool);
    const request = {
      organizationId,
      workspaceId,
      websiteProjectId: projectB.websiteProjectId,
      actorId,
      requestId: "phase2-v2-launch-request",
      idempotencyKey: "phase2-v2-launch",
      providerBudgetAuthorization: bindProviderOperationBudgetAuthorization(
        {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 1,
          maxCostMicros: 1_000_000,
        },
        { authorizedBy: actorId },
      ),
    };

    const launched = await repository.stage(request);
    expect(launched).toMatchObject({
      recommendationContextVersionId: projectB.contextId,
      visiblePoolGeneration: 3,
      replayed: false,
    });
    expect(launched.inputPinId).not.toBe(projectB.pinId);
    expect(launched.generationContractId).toMatch(/^[0-9a-f-]{36}$/);
    expect(launched.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(launched.workflowId).toContain(launched.generationContractId);

    const pinLineage = await client.query(
      `SELECT generation.qualification_contract_version
                "generationQualificationContractVersion",
              generation.visibility_contract_version
                "visibilityContractVersion",
              generation.score_model_version "materializationContractVersion",
              generation.creator_worker_contract_version
                "workerContractVersion",
              generation.seed_contract_version "seedContractVersion",
              pin.qualification_contract_version
                "pinQualificationContractVersion",
              pin.project_context_version "projectContextVersion",
              pin.site_profile_version_id "siteProfileVersionId",
              pin.outreach_profile_version_id "outreachProfileVersionId",
              pin.promotion_target_version_id "promotionTargetVersionId"
         FROM backlinks.backlink_recommendation_generation_contracts generation
         JOIN backlinks.backlink_generation_input_pins pin
           ON pin.organization_id=generation.organization_id
          AND pin.workspace_id=generation.workspace_id
          AND pin.website_project_id=generation.website_project_id
          AND pin.id=generation.input_pin_id
        WHERE generation.id=$1`,
      [launched.generationContractId],
    );
    expect(pinLineage.rows).toEqual([
      {
        generationQualificationContractVersion:
          "recommendation-pool-admission.v2",
        visibilityContractVersion: "recommendation-pool-release-visibility.v2",
        materializationContractVersion:
          "recommendation-pool-materialization.v2",
        workerContractVersion: "recommendation-pool-worker.v2",
        seedContractVersion: "recommendation-seed.v2",
        pinQualificationContractVersion: "recommendation-pool-admission.v2",
        projectContextVersion: 3,
        siteProfileVersionId: "site-profile-b",
        outreachProfileVersionId: projectB.profileId,
        promotionTargetVersionId: "target-b",
      },
    ]);
    const historicalPin = await client.query(
      `SELECT qualification_contract_version "qualificationContractVersion",
              immutable_fingerprint "immutableFingerprint"
         FROM backlinks.backlink_generation_input_pins
        WHERE id=$1`,
      [projectB.pinId],
    );
    expect(historicalPin.rows).toEqual([
      {
        qualificationContractVersion: "recommendation-qualification.v1",
        immutableFingerprint: "pin-fingerprint-b",
      },
    ]);

    const persisted = await client.query(
      `SELECT generation.request_fingerprints "requestFingerprints",
              job.status,job.step,job.result_summary "resultSummary"
         FROM backlinks.backlink_recommendation_generation_contracts
           AS generation
         JOIN backlinks.backlink_jobs AS job
           ON job.organization_id=generation.organization_id
          AND job.workspace_id=generation.workspace_id
          AND job.website_project_id=generation.website_project_id
          AND job.result_summary->>'generationContractId'=
                generation.id::text
        WHERE generation.id=$1 AND job.id=$2`,
      [launched.generationContractId, launched.jobId],
    );
    expect(persisted.rows).toEqual([
      expect.objectContaining({
        requestFingerprints: expect.objectContaining({
          nativeV2GenerationLaunch: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        status: "queued",
        step: "generation_staged",
        resultSummary: expect.objectContaining({
          poolContractVersion: "recommendation-pool.v2",
          generationContractId: launched.generationContractId,
          visiblePoolGeneration: 3,
          providerBudgetAuthorization: {
            provider: "dataforseo",
            reasonCode: "user_authorized_bounded_real_refill",
            maxPaidCalls: 1,
            maxCostMicros: 1_000_000,
            authorizedBy: actorId,
          },
        }),
      }),
    ]);

    await expect(repository.stage(request)).resolves.toEqual({
      ...launched,
      replayed: true,
    });
    const prepared = await createRecommendationSeedRepository(pool).prepare({
      organizationId,
      workspaceId,
      websiteProjectId: projectB.websiteProjectId,
      actorId,
      trigger: "USER_TRIGGERED",
      idempotencyKey: "phase2-v2-launch-seeds",
      requestHash: "phase2-v2-launch-seeds-hash",
      requestId: "phase2-v2-launch-seeds-request",
      userSeeds: [],
      systemCandidates: [],
      targetGenerationContractId: launched.generationContractId,
    });
    expect(prepared.state).toBe("READY");
    await expect(
      withBacklinkTenantTransaction(
        pool,
        {
          organizationId,
          workspaceId,
          websiteProjectId: projectB.websiteProjectId,
        },
        (transaction) =>
          createRecommendationPoolV2Repository(transaction).loadGeneration({
            organizationId,
            workspaceId,
            websiteProjectId: projectB.websiteProjectId,
            generationContractId: launched.generationContractId,
            recommendationContextVersionId:
              launched.recommendationContextVersionId,
            visiblePoolGeneration: launched.visiblePoolGeneration,
            inputPinId: launched.inputPinId,
            jobId: launched.jobId,
            workflowId: launched.workflowId,
            actorId,
            rounds: [],
          }),
      ),
    ).resolves.toEqual({ status: "ready" });
    const runningJob = await client.query(
      `SELECT status,step,progress
         FROM backlinks.backlink_jobs
        WHERE id=$1`,
      [launched.jobId],
    );
    expect(runningJob.rows).toEqual([
      { status: "running", step: "discovery", progress: 10 },
    ]);

    const persistEmptyTerminal = async (
      generation: RecommendationPoolV2GenerationLaunch,
      terminalFactId: string,
      completedAt: string,
      fingerprintCharacter: string,
    ) => {
      await client.query("SET session_replication_role = replica");
      try {
        await client.query(
          `UPDATE backlinks.backlink_recommendation_generation_contracts
              SET effective_unique_candidate_count=0,
                  canonical_batch_size=0,
                  canonical_batch_count=0,
                  canonical_order_fingerprint=$2,
                  discovery_terminal_reason='PATHS_EXHAUSTED',
                  discovery_completed_at=$3
            WHERE id=$1`,
          [
            generation.generationContractId,
            fingerprintCharacter.repeat(64),
            completedAt,
          ],
        );
        await client.query(
          `INSERT INTO backlinks
             .backlink_recommendation_discovery_generation_terminal_facts (
               id,organization_id,workspace_id,website_project_id,
               generation_contract_id,recommendation_context_version_id,
               visible_pool_generation,input_pin_id,pool_contract_version,
               discovery_budget_policy_version,
               effective_unique_candidate_count,terminal_reason,
               total_settled_cost_micros,charge_state,
               completed_round_count,completed_window_count,
               canonical_request_set_fingerprint,completed_at,created_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',
               'recommendation-discovery-budget.v1',0,'PATHS_EXHAUSTED',
               0,'SETTLED',1,1,$9,$10,'phase2-seed-fixture'
             )`,
          [
            terminalFactId,
            organizationId,
            workspaceId,
            projectB.websiteProjectId,
            generation.generationContractId,
            generation.recommendationContextVersionId,
            generation.visiblePoolGeneration,
            generation.inputPinId,
            fingerprintCharacter.repeat(64),
            completedAt,
          ],
        );
      } finally {
        await client.query("SET session_replication_role = origin");
      }
    };

    await persistEmptyTerminal(
      launched,
      "9a000000-0000-4000-8000-000000000051",
      "2026-09-02T00:00:00.000Z",
      "a",
    );
    await withBacklinkTenantTransaction(
      pool,
      {
        organizationId,
        workspaceId,
        websiteProjectId: projectB.websiteProjectId,
      },
      (transaction) =>
        createRecommendationPoolV2Repository(
          transaction,
        ).completeGenerationWithoutPublication({
          organizationId,
          workspaceId,
          websiteProjectId: projectB.websiteProjectId,
          generationContractId: launched.generationContractId,
          recommendationContextVersionId:
            launched.recommendationContextVersionId,
          visiblePoolGeneration: launched.visiblePoolGeneration,
          inputPinId: launched.inputPinId,
          jobId: launched.jobId,
          workflowId: launched.workflowId,
          actorId,
          reason: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
        }),
    );
    const terminalJob = await client.query(
      `SELECT status,step,progress,error,result_summary "resultSummary"
         FROM backlinks.backlink_jobs
        WHERE id=$1`,
      [launched.jobId],
    );
    expect(terminalJob.rows).toEqual([
      expect.objectContaining({
        status: "success",
        step: "completed_no_valid_candidates",
        progress: 100,
        error: null,
        resultSummary: expect.objectContaining({
          final: true,
          outcome: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
          terminalReason: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
          discoveryTerminalReason: "PATHS_EXHAUSTED",
          terminalFactId: "9a000000-0000-4000-8000-000000000051",
          effectiveUniqueCandidateCount: 0,
          admittedCount: 0,
          releasedCount: 0,
          releaseResult: "NO_BATCH",
        }),
      }),
    ]);

    const failedGeneration = await repository.stage({
      ...request,
      requestId: "phase2-v2-launch-workflow-failure-request",
      idempotencyKey: "phase2-v2-launch-workflow-failure",
    });
    await withBacklinkTenantTransaction(
      pool,
      {
        organizationId,
        workspaceId,
        websiteProjectId: projectB.websiteProjectId,
      },
      (transaction) =>
        createRecommendationPoolV2Repository(transaction).failGeneration({
          organizationId,
          workspaceId,
          websiteProjectId: projectB.websiteProjectId,
          generationContractId: failedGeneration.generationContractId,
          recommendationContextVersionId:
            failedGeneration.recommendationContextVersionId,
          visiblePoolGeneration: failedGeneration.visiblePoolGeneration,
          inputPinId: failedGeneration.inputPinId,
          jobId: failedGeneration.jobId,
          workflowId: failedGeneration.workflowId,
          actorId,
          failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
          failureMessage: "Provider lease lineage was rejected.",
        }),
    );
    const failedJob = await client.query(
      `SELECT status,step,progress,error,result_summary "resultSummary"
         FROM backlinks.backlink_jobs
        WHERE id=$1`,
      [failedGeneration.jobId],
    );
    expect(failedJob.rows).toEqual([
      expect.objectContaining({
        status: "failed",
        step: "workflow_failed",
        progress: 100,
        error: {
          code: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
          message: "Provider lease lineage was rejected.",
          retryable: false,
        },
        resultSummary: expect.objectContaining({
          final: true,
          outcome: "FAILED",
          terminalReason: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
          failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
          failureMessage: "Provider lease lineage was rejected.",
          failureRetryable: false,
        }),
      }),
    ]);

    const next = await repository.stage({
      ...request,
      requestId: "phase2-v2-launch-next-request",
      idempotencyKey: "phase2-v2-launch-next",
    });
    expect(next).toMatchObject({
      visiblePoolGeneration: 5,
      replayed: false,
    });
    const nextPrepared = await createRecommendationSeedRepository(pool).prepare(
      {
        organizationId,
        workspaceId,
        websiteProjectId: projectB.websiteProjectId,
        actorId,
        trigger: "USER_TRIGGERED",
        idempotencyKey: "phase2-v2-launch-next-seeds",
        requestHash: "phase2-v2-launch-next-seeds-hash",
        requestId: "phase2-v2-launch-next-seeds-request",
        userSeeds: [],
        systemCandidates: [],
        targetGenerationContractId: next.generationContractId,
      },
    );
    expect(nextPrepared).toMatchObject({
      state: "READY",
      reasonCodes: [],
    });
    expect(nextPrepared.blueprintSeedReferences).toHaveLength(
      prepared.blueprintSeedReferences.length,
    );
    const launchedBlueprintId =
      prepared.blueprintSeedReferences[0]?.blueprintId;
    const nextBlueprintId =
      nextPrepared.blueprintSeedReferences[0]?.blueprintId;
    expect(launchedBlueprintId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextBlueprintId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextBlueprintId).not.toBe(launchedBlueprintId);
    expect(
      nextPrepared.blueprintSeedReferences.every(
        ({ blueprintId }) => blueprintId === nextBlueprintId,
      ),
    ).toBe(true);
    const crossGenerationAssignments = await client.query(
      `SELECT generation_contract_id "generationContractId",
              blueprint_id "blueprintId",count(*)::integer count
         FROM backlinks.backlink_commercial_blueprint_seeds
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND generation_contract_id IN ($4,$5)
        GROUP BY generation_contract_id,blueprint_id
        ORDER BY generation_contract_id`,
      [
        organizationId,
        workspaceId,
        projectB.websiteProjectId,
        launched.generationContractId,
        next.generationContractId,
      ],
    );
    expect(crossGenerationAssignments.rows).toEqual(
      expect.arrayContaining([
        {
          generationContractId: launched.generationContractId,
          blueprintId: launchedBlueprintId,
          count: prepared.blueprintSeedReferences.length,
        },
        {
          generationContractId: next.generationContractId,
          blueprintId: nextBlueprintId,
          count: nextPrepared.blueprintSeedReferences.length,
        },
      ]),
    );
    await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='running',step='supply_window_stored',progress=60,
              started_at=statement_timestamp()
        WHERE id=$1`,
      [next.jobId],
    );
    await persistEmptyTerminal(
      next,
      "9a000000-0000-4000-8000-000000000052",
      "2026-09-02T00:01:00.000Z",
      "b",
    );

    const afterReconciliation = await repository.stage({
      ...request,
      requestId: "phase2-v2-launch-after-reconciliation-request",
      idempotencyKey: "phase2-v2-launch-after-reconciliation",
    });
    expect(afterReconciliation).toMatchObject({
      visiblePoolGeneration: 6,
      replayed: false,
    });
    const reconciledJob = await client.query(
      `SELECT status,step,progress,result_summary "resultSummary"
         FROM backlinks.backlink_jobs
        WHERE id=$1`,
      [next.jobId],
    );
    expect(reconciledJob.rows).toEqual([
      expect.objectContaining({
        status: "success",
        step: "completed_no_valid_candidates",
        progress: 100,
        resultSummary: expect.objectContaining({
          outcome: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
          terminalReason: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
          discoveryTerminalReason: "PATHS_EXHAUSTED",
          admittedCount: 0,
          releasedCount: 0,
          releaseResult: "NO_BATCH",
          terminalFactId: "9a000000-0000-4000-8000-000000000052",
          reconciledFromTerminalFact: true,
        }),
      }),
    ]);

    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET created_by='phase2-illegal-v1-update'
          WHERE id=$1`,
        [migratedGenerationId],
      ),
    ).rejects.toThrow(/read-only|immutable/i);
  });
});
