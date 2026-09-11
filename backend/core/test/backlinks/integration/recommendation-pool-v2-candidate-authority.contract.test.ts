import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  backlinkRecommendationCandidateMetricSnapshots,
  backlinkRecommendationGenerationCandidateLinks,
  backlinkRecommendationGenerationCandidates,
  backlinkRecommendationGenerationCandidateSources,
} from "../../../src/modules/backlinks/db/schema/recommendations.js";

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
    prerequisites: readonly string[];
  }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
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

describe("recommendation pool V2 candidate authority schema contract", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let manifest: DeploymentManifest;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    await installBacklinksManifestAfterFoundation(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("registers exact forward-only migration 0091 in the current chain", async () => {
    const migration = manifest.steps.find(
      ({ migrationId }) => migrationId === "backlinks-0091",
    );

    expect(manifest.heads.backlinks).toBe("0098");
    expect(migration).toMatchObject({
      path:
        "backend/core/src/modules/backlinks/db/migrations/" +
        "0091_backlink_recommendation_pool_v2_candidate_facts.sql",
      prerequisites: ["backlinks-0090"],
    });
    expect(migration?.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (migration === undefined) {
      throw new Error("backlinks-0091 is missing from the manifest.");
    }
    const migrationSql = (
      await readFile(migrationUrl(migration.path), "utf8")
    ).replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      migration.sha256,
    );
    expect(migrationSql.trimStart()).toMatch(/^BEGIN;/);
    expect(migrationSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("creates the four V2 candidate-authority tables with forced tenant RLS", async () => {
    const expectedTables = [
      "backlink_recommendation_candidate_metric_snapshots",
      "backlink_recommendation_generation_candidate_links",
      "backlink_recommendation_generation_candidate_sources",
      "backlink_recommendation_generation_candidates",
    ];
    const result = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity
         FROM pg_class
        WHERE relnamespace='backlinks'::regnamespace
          AND relname=ANY($1::text[])
        ORDER BY relname`,
      [expectedTables],
    );

    expect(result.rows).toEqual(
      expectedTables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  it("exposes all four authority tables through the generated schema", () => {
    expect(backlinkRecommendationGenerationCandidates).toBeDefined();
    expect(backlinkRecommendationGenerationCandidateSources).toBeDefined();
    expect(backlinkRecommendationCandidateMetricSnapshots).toBeDefined();
    expect(backlinkRecommendationGenerationCandidateLinks).toBeDefined();
  });

  it("persists the complete candidate, source, metric, and link facts", async () => {
    const expectedColumns = {
      backlink_recommendation_candidate_metric_snapshots: [
        "artifact_ref",
        "endpoint",
        "generation_candidate_id",
        "language",
        "location",
        "market",
        "metric_type",
        "metric_value",
        "provider",
        "request_intent",
        "request_ref",
        "value_state",
      ],
      backlink_recommendation_generation_candidate_links: [
        "candidate_id",
        "generation_candidate_id",
        "idempotency_fingerprint",
        "inventory_id",
        "materialization_contract_version",
        "prospect_id",
        "recommendation_id",
      ],
      backlink_recommendation_generation_candidate_sources: [
        "discovered_url",
        "evidence_fingerprint",
        "generation_candidate_id",
        "provider_outcome",
        "request_intent",
        "source_ref",
        "source_type",
      ],
      backlink_recommendation_generation_candidates: [
        "admission_contract_version",
        "admission_state",
        "admitted_at",
        "canonical_domain",
        "decision_evidence",
        "excluded_at",
        "exclusion_reason_code",
        "first_seen_at",
        "first_seen_request_intent",
        "recommendation_reason_codes",
        "recommended",
      ],
    } as const;
    for (const [tableName, columnNames] of Object.entries(expectedColumns)) {
      const result = await client.query(
        `SELECT column_name "columnName"
           FROM information_schema.columns
          WHERE table_schema='backlinks' AND table_name=$1
            AND column_name=ANY($2::text[])
          ORDER BY column_name`,
        [tableName, columnNames],
      );
      expect(result.rows.map(({ columnName }) => columnName)).toEqual(
        [...columnNames].sort(),
      );
    }
  });

  it("adds exact Blueprint, carrier, recommendation, and release lineage columns", async () => {
    const result = await client.query(`
      SELECT table_name AS "tableName",column_name AS "columnName"
        FROM information_schema.columns
       WHERE table_schema='backlinks'
         AND (
           (
             table_name='backlink_commercial_discovery_blueprints'
             AND column_name='seed_snapshot_fingerprint'
           )
           OR (
             table_name='backlink_commercial_discovery_batches'
             AND column_name IN (
               'generation_contract_id',
               'input_pin_id',
               'materialization_contract_version',
               'pool_contract_version'
             )
           )
           OR (
             table_name='backlink_recommendations'
             AND column_name IN (
               'generation_contract_id',
               'input_pin_id',
               'materialization_contract_version',
               'pool_contract_version',
               'visible_pool_generation'
             )
           )
           OR (
             table_name='backlink_recommendation_release_batch_items'
             AND column_name IN (
               'candidate_id',
               'generation_candidate_id',
               'inventory_id',
               'prospect_id',
               'recommendation_id'
             )
           )
         )
       ORDER BY table_name,column_name
    `);

    expect(result.rows).toEqual([
      {
        tableName: "backlink_commercial_discovery_batches",
        columnName: "generation_contract_id",
      },
      {
        tableName: "backlink_commercial_discovery_batches",
        columnName: "input_pin_id",
      },
      {
        tableName: "backlink_commercial_discovery_batches",
        columnName: "materialization_contract_version",
      },
      {
        tableName: "backlink_commercial_discovery_batches",
        columnName: "pool_contract_version",
      },
      {
        tableName: "backlink_commercial_discovery_blueprints",
        columnName: "seed_snapshot_fingerprint",
      },
      {
        tableName: "backlink_recommendation_release_batch_items",
        columnName: "candidate_id",
      },
      {
        tableName: "backlink_recommendation_release_batch_items",
        columnName: "generation_candidate_id",
      },
      {
        tableName: "backlink_recommendation_release_batch_items",
        columnName: "inventory_id",
      },
      {
        tableName: "backlink_recommendation_release_batch_items",
        columnName: "prospect_id",
      },
      {
        tableName: "backlink_recommendation_release_batch_items",
        columnName: "recommendation_id",
      },
      {
        tableName: "backlink_recommendations",
        columnName: "generation_contract_id",
      },
      {
        tableName: "backlink_recommendations",
        columnName: "input_pin_id",
      },
      {
        tableName: "backlink_recommendations",
        columnName: "materialization_contract_version",
      },
      {
        tableName: "backlink_recommendations",
        columnName: "pool_contract_version",
      },
      {
        tableName: "backlink_recommendations",
        columnName: "visible_pool_generation",
      },
    ]);
  });

  it("enforces the closed hard-exclusion set without a score threshold", async () => {
    const result = await client.query(`
      SELECT lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname='backlink_recommendation_generation_candidates'
       ORDER BY schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ definition }) => String(definition))
      .join("\n");

    for (const code of [
      "self_domain",
      "invalid_domain",
      "unreachable_domain",
      "malicious_or_blocked",
      "already_released_to_project",
      "existing_project_opportunity",
      "obviously_unrelated",
      "permanently_excluded",
    ]) {
      expect(definitions).toContain(code);
    }
    expect(definitions).not.toContain("score_below_threshold");
    expect(definitions).toContain("recommendation-pool-admission.v2");
    expect(definitions).toContain("decision_evidence");
    expect(definitions).toContain("first_seen_request_intent");
    expect(definitions).toContain("recommendation_reason_codes");
    expect(definitions).toContain("admitted_at");
    expect(definitions).toContain("excluded_at");
    expect(definitions).toContain(
      "unique (organization_id, workspace_id, website_project_id, " +
        "generation_contract_id, canonical_domain)",
    );
  });

  it("binds carrier and recommendation rows to one exact staged V2 lineage", async () => {
    const result = await client.query(`
      SELECT relation.relname,
             lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname IN (
           'backlink_commercial_discovery_batches',
           'backlink_recommendations'
         )
       ORDER BY relation.relname,schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ relname, definition }) => `${relname}: ${definition}`)
      .join("\n");

    expect(definitions).toContain("generation_contract_id");
    expect(definitions).toContain("visible_pool_generation");
    expect(definitions).toContain("input_pin_id");
    expect(definitions).toContain("pool_contract_version");
    expect(definitions).toContain("recommendation-pool-materialization.v2");
    expect(definitions).toContain("v2_materialization");
  });

  it("retains repeated discovery evidence behind one candidate identity", async () => {
    const result = await client.query(`
      SELECT relation.relname,
             lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname IN (
           'backlink_recommendation_generation_candidate_sources',
           'backlink_recommendation_generation_candidate_links'
         )
       ORDER BY relation.relname,schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ relname, definition }) => `${relname}: ${definition}`)
      .join("\n");

    expect(definitions).toContain("generation_candidate_id");
    expect(definitions).toContain("evidence_fingerprint");
    expect(definitions).toContain("request_intent");
    expect(definitions).toContain("provider_outcome");
    expect(definitions).toContain("discovered_url");
    expect(definitions).toContain("idempotency_fingerprint");
    expect(definitions).toContain("materialization_contract_version");
    expect(definitions).toContain(
      "backlink_recommendation_generation_candidates",
    );
    expect(definitions).toContain("backlink_commercial_candidates");
    expect(definitions).toContain("backlink_recommendations");
    expect(definitions).toContain("backlink_prospects");
    expect(definitions).toContain("backlink_recommendation_inventory");
  });

  it("retains evidence for historical-domain exclusions and keeps both release race guards", async () => {
    const result = await client.query(`
      SELECT relation.relname,
             lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname IN (
           'backlink_recommendation_generation_candidates',
           'backlink_recommendation_generation_candidate_sources',
           'backlink_recommendation_release_batch_items'
         )
       ORDER BY relation.relname,schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ relname, definition }) => `${relname}: ${definition}`)
      .join("\n");

    expect(definitions).toContain("already_released_to_project");
    expect(definitions).toContain("existing_project_opportunity");
    expect(definitions).toContain("generation_candidate_id");
    expect(definitions).toContain("evidence_fingerprint");
    expect(definitions).toContain(
      "unique (organization_id, workspace_id, website_project_id, " +
        "generation_contract_id, canonical_domain)",
    );
    expect(definitions).toContain(
      "unique (organization_id, workspace_id, website_project_id, " +
        "canonical_domain)",
    );
  });

  it("keeps native release lineage complete and project-domain release unique", async () => {
    const result = await client.query(`
      SELECT lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname='backlink_recommendation_release_batch_items'
       ORDER BY schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ definition }) => String(definition))
      .join("\n");

    expect(definitions).toContain("generation_candidate_id");
    expect(definitions).toContain(
      "backlink_recommendation_generation_candidates",
    );
    expect(definitions).toContain("backlink_commercial_candidates");
    expect(definitions).toContain("backlink_recommendations");
    expect(definitions).toContain("backlink_prospects");
    expect(definitions).toContain("backlink_recommendation_inventory");
    expect(definitions).toContain(
      "unique (organization_id, workspace_id, website_project_id, " +
        "canonical_domain)",
    );
  });

  it("permits only the deterministic zero-cost V2 compatibility state", async () => {
    const result = await client.query(`
      SELECT relation.relname,
             lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname IN (
           'backlink_commercial_candidates',
           'backlink_commercial_discovery_batches',
           'backlink_recommendation_inventory'
         )
       ORDER BY relation.relname,schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ relname, definition }) => `${relname}: ${definition}`)
      .join("\n");

    expect(definitions).toContain("v2_materialization");
    expect(definitions).toContain("v2_materialized");
    expect(definitions).toContain("recommendation-pool-materialization.v2");
    expect(definitions).toContain("v2_canonical_materialization");
    expect(definitions).toContain("paid_cost_micros = 0");
    expect(definitions).toContain("fit_decision = 'unassessed'");
    expect(definitions).toContain("fit_score_model_version is null");
    expect(definitions).toContain("publication_status <> 'published'");

    const triggerResult = await client.query<{
      relationName: string;
      protectsDelete: boolean;
      protectsInsert: boolean;
      protectsUpdate: boolean;
    }>(`
      SELECT relation.relname AS "relationName",
             (trigger_row.tgtype & 8) = 8 AS "protectsDelete",
             (trigger_row.tgtype & 4) = 4 AS "protectsInsert",
             (trigger_row.tgtype & 16) = 16 AS "protectsUpdate"
        FROM pg_trigger AS trigger_row
        JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
       WHERE NOT trigger_row.tgisinternal
         AND relation.relnamespace = 'backlinks'::regnamespace
         AND trigger_row.tgname IN (
           'backlink_commercial_candidate_v2_materialization_guard',
           'backlink_generation_candidate_immutable',
           'backlink_generation_candidate_source_immutable',
           'backlink_candidate_metric_snapshot_immutable',
           'backlink_generation_candidate_link_immutable'
         )
       ORDER BY relation.relname
    `);
    const protectedRelations = new Map(
      triggerResult.rows.map((row) => [row.relationName, row]),
    );

    for (const relationName of [
      "backlink_recommendation_generation_candidates",
      "backlink_recommendation_generation_candidate_sources",
      "backlink_recommendation_candidate_metric_snapshots",
      "backlink_recommendation_generation_candidate_links",
    ]) {
      expect(protectedRelations.get(relationName)).toMatchObject({
        protectsDelete: true,
        protectsUpdate: true,
      });
    }
    expect(
      protectedRelations.get("backlink_commercial_candidates"),
    ).toMatchObject({
      protectsDelete: true,
      protectsInsert: true,
      protectsUpdate: true,
    });
  });

  it("stores unavailable metric outcomes without changing candidate admission", async () => {
    const result = await client.query(`
      SELECT lower(pg_get_constraintdef(schema_constraint.oid)) AS definition
        FROM pg_constraint AS schema_constraint
        JOIN pg_class AS relation ON relation.oid=schema_constraint.conrelid
       WHERE relation.relnamespace='backlinks'::regnamespace
         AND relation.relname=
               'backlink_recommendation_candidate_metric_snapshots'
       ORDER BY schema_constraint.conname
    `);
    const definitions = result.rows
      .map(({ definition }) => String(definition))
      .join("\n");

    expect(definitions).toContain("value_state");
    expect(definitions).toContain("available");
    expect(definitions).toContain("unavailable");
    expect(definitions).toContain("failed");
    expect(definitions).toContain("unsupported");
    expect(definitions).toContain("metric_value is null");
    expect(definitions).not.toContain("admission_state");
  });

  it("authorizes same or changed staged V2 context only from exact complete lineage", async () => {
    const result = await client.query(`
      SELECT lower(pg_get_functiondef(procedure.oid)) AS definition
        FROM pg_proc AS procedure
       WHERE procedure.pronamespace='backlinks'::regnamespace
         AND procedure.proname=
             'backlink_phase9_can_insert_v2_recommendation'
    `);
    const definition = String(result.rows[0]?.definition ?? "");

    expect(definition).toContain("generation_contract_id");
    expect(definition).toContain("recommendation_context_version_id");
    expect(definition).toContain("visible_pool_generation");
    expect(definition).toContain("input_pin_id");
    expect(definition).toContain("pool_contract_version");
    expect(definition).toContain("materialization_contract_version");
    expect(definition).toContain("recommendation-pool.v2");
    expect(definition).toContain("recommendation-pool-materialization.v2");
    expect(definition).not.toContain(
      "backlink_recommendation_pool_project_contracts",
    );
    expect(definition).not.toContain("recommendation-qualification.v1");
  });
});
