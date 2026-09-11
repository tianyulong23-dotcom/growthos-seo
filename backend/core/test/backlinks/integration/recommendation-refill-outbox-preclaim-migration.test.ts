import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

const refillEventType = "backlinks.recommendation-refill.requested.v1";
const actor = "phase3-preclaim-test";
const uuid = (prefix: string, sequence: number) =>
  `${prefix}000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

describe("recommendation refill atomic pre-claim migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let manifest: DeploymentManifest;
  let migration0081: string;
  let sequence = 0;

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

    manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    const steps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const manifestHeadStep = steps.at(-1);
    expect(manifestHeadStep).toBeDefined();
    expect(manifest.heads.backlinks).toBe(
      manifestHeadStep?.migrationId.replace(/^backlinks-/, ""),
    );
    const step0081 = steps.find(
      ({ migrationId }) => migrationId === "backlinks-0081",
    );
    expect(step0081?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const step0081Index = steps.findIndex(
      ({ migrationId }) => migrationId === "backlinks-0081",
    );
    expect(step0081Index).toBeGreaterThanOrEqual(0);
    for (const step of steps.slice(0, step0081Index)) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }

    expect(
      (
        await client.query(
          `SELECT to_regprocedure(
             'backlinks.backlink_claim_recommendation_refill_outbox_events(
                text,integer,timestamptz,uuid,uuid,uuid,uuid
              )'
           ) AS procedure`,
        )
      ).rows,
    ).toEqual([{ procedure: null }]);

    migration0081 = await readFile(migrationUrl(step0081?.path ?? ""), "utf8");
    await client.query(migration0081);
  }, 180_000);

  beforeEach(async () => {
    await client.query(`
      SET search_path = backlinks, pg_catalog;
      TRUNCATE backlink_recommendation_pool_v2_cutover_control,
        backlink_recommendation_pool_project_contracts,
        backlink_recommendation_generation_contracts,
        backlink_generation_input_pins,
        backlink_outreach_profile_versions,
        backlink_recommendation_refills,
        backlink_outbox_events,
        backlink_jobs
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  async function insertProjectContract(
    scope: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
    }>,
    inputPinId: string,
    state:
      | "V1_ACTIVE"
      | "V2_READY"
      | "V2_ACTIVE"
      | "MIGRATION_BLOCKED"
      | "V2_MAINTENANCE_READ_ONLY",
  ) {
    const poolContractVersion =
      state === "V1_ACTIVE"
        ? "recommendation-pool.v1"
        : "recommendation-pool.v2";
    const requiresActiveLineage =
      state === "V2_ACTIVE" || state === "V2_MAINTENANCE_READ_ONLY";
    const generationContractId = requiresActiveLineage
      ? uuid("49", ++sequence)
      : null;
    const recommendationContextVersionId = requiresActiveLineage
      ? uuid("4a", sequence)
      : null;
    if (generationContractId !== null) {
      await client.query(
        `INSERT INTO backlink_recommendation_generation_contracts (
           id, organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, visible_pool_generation,
           input_pin_id, qualification_contract_version,
           visibility_contract_version, score_model_version, metric_scope,
           market, location, language, traffic_location_code,
           traffic_language_code, request_fingerprints,
           creator_worker_contract_version, pool_contract_version,
           effective_unique_candidate_count, canonical_batch_size,
           canonical_batch_count, canonical_order_fingerprint,
           discovery_terminal_reason, discovery_completed_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, 2, $6,
           'recommendation-qualification.v1',
           'recommendation-visibility.v1',
           'recommendation-commercial-fit.v4', 'TARGET_MARKET',
           'US', 'United States', 'en', 2840, 'en', '{}'::jsonb,
           'recommendation-qualification.v1', 'recommendation-pool.v2',
           0, 0, 0, $7, 'PATHS_EXHAUSTED', statement_timestamp(), $8
         )`,
        [
          generationContractId,
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          recommendationContextVersionId,
          inputPinId,
          `completed-v2-${sequence}`,
          actor,
        ],
      );
    }
    await client.query(
      `INSERT INTO backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, activated_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid,
         CASE WHEN $7::uuid IS NULL THEN NULL ELSE 2 END, $9::uuid,
         CASE WHEN $6 IN ('V2_ACTIVE', 'V2_MAINTENANCE_READ_ONLY')
           THEN statement_timestamp() ELSE NULL END, $10, $10
       )`,
      [
        uuid("81", ++sequence),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        poolContractVersion,
        state,
        generationContractId,
        recommendationContextVersionId,
        requiresActiveLineage ? inputPinId : null,
        actor,
      ],
    );
  }

  async function appendRefill(
    state:
      | "V1_ACTIVE"
      | "V2_READY"
      | "V2_ACTIVE"
      | "MIGRATION_BLOCKED"
      | "V2_MAINTENANCE_READ_ONLY" = "V1_ACTIVE",
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    const current = ++sequence;
    const scope = {
      organizationId: uuid("10", current),
      workspaceId: uuid("20", current),
      websiteProjectId: uuid("30", current),
    };
    const outreachProfileId = uuid("40", current);
    const inputPinId = uuid("41", current);
    const generationId = uuid("42", current);
    const contextId = uuid("43", current);
    const jobId = uuid("44", current);
    const eventId = uuid("45", current);
    const workflowId = `backlinks:${scope.workspaceId}:${scope.websiteProjectId}:recommendation-refill:v1:${jobId}`;
    const refillWindowKey = `manual-${current}`;

    await client.query(
      `INSERT INTO backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, 'profile-v1', 'target-v1',
         '["topic"]'::jsonb, '["product"]'::jsonb, '[]'::jsonb,
         '["audience"]'::jsonb, '["editorial review"]'::jsonb,
         'US', 'United States', 'en',
         '["shared-seo-evidence"]'::jsonb, $5, $6
       )`,
      [
        outreachProfileId,
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        `profile-${current}`,
        actor,
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
         $1, $2, $3, $4, 1, 'site-profile-v1', $5, 'target-v1',
         '[]'::jsonb, '[]'::jsonb, 'US',
         'recommendation-qualification.v1', $6, $7
       )`,
      [
        inputPinId,
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        outreachProfileId,
        `input-${current}`,
        actor,
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
         creator_worker_contract_version, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 1, $6,
         'recommendation-qualification.v1',
         'recommendation-visibility.v1',
         'recommendation-commercial-fit.v4', 'TARGET_MARKET',
         'US', 'United States', 'en', 2840, 'en', '{}'::jsonb,
         'recommendation-qualification.v1', $7
       )`,
      [
        generationId,
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        contextId,
        inputPinId,
        actor,
      ],
    );
    await insertProjectContract(scope, inputPinId, state);
    await client.query(
      `INSERT INTO backlink_jobs (
         id, organization_id, workspace_id, website_project_id,
         job_type, source_object_type, source_object_id, workflow_id,
         correlation_id, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, 'recommendation_refill',
         'recommendation_context', $5, $6, $7, $8, $8
       )`,
      [
        jobId,
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        contextId,
        workflowId,
        eventId,
        actor,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_refills (
         id, organization_id, workspace_id, website_project_id,
         job_id, recommendation_context_version_id, trigger_reason,
         low_watermark, high_watermark, refill_window_key,
         visible_pool_generation, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'manual', 9, 10, $7, 1, $8, $8
       )`,
      [
        uuid("46", current),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        jobId,
        contextId,
        refillWindowKey,
        actor,
      ],
    );
    const payload = {
      contractVersion: refillEventType,
      ...scope,
      recommendationContextVersionId: contextId,
      visiblePoolGeneration: 1,
      jobId,
      workflowId,
      correlationId: eventId,
      actorId: actor,
      refillWindowKey,
      lowWatermark: 9,
      highWatermark: 10,
      ...overrides,
    };
    await client.query(
      `INSERT INTO backlink_outbox_events (
         id, organization_id, workspace_id, website_project_id,
         event_type, aggregate_id, aggregate_version, idempotency_key,
         payload, payload_schema_version, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8::jsonb, 1, $9, $9)`,
      [
        eventId,
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        refillEventType,
        jobId,
        workflowId,
        JSON.stringify(payload),
        actor,
      ],
    );
    return { ...scope, eventId, jobId, workflowId };
  }

  async function claim(
    workerId: string,
    scope?: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      eventId?: string;
    }>,
    staleClaimBefore: Date | null = null,
  ) {
    return client.query(
      `SELECT *
         FROM backlink_claim_recommendation_refill_outbox_events(
           $1, 10, $2, $3, $4, $5, $6
         )`,
      [
        workerId,
        staleClaimBefore,
        scope?.organizationId ?? null,
        scope?.workspaceId ?? null,
        scope?.websiteProjectId ?? null,
        scope?.eventId ?? null,
      ],
    );
  }

  async function stored(eventId: string) {
    return (
      await client.query(
        `SELECT status, claimed_at AS "claimedAt", claimed_by AS "claimedBy",
                attempt_count AS "attemptCount"
           FROM backlink_outbox_events
          WHERE id=$1`,
        [eventId],
      )
    ).rows[0];
  }

  it("upgrades 0080 to 0081 idempotently with restricted fixed-path functions", async () => {
    await expect(client.query(migration0081)).resolves.toBeDefined();
    const functions = await client.query(`
      SELECT p.proname,
             p.prosecdef AS "securityDefiner",
             p.proconfig AS config,
             has_function_privilege(
               'public',
               p.oid,
               'EXECUTE'
             ) AS "publicExecute",
             has_function_privilege(
               'growthos_backlinks_writer',
               p.oid,
               'EXECUTE'
             ) AS "writerExecute"
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid=p.pronamespace
       WHERE n.nspname='backlinks'
         AND p.proname IN (
           'backlink_claim_outbox_events',
           'backlink_claim_recommendation_refill_outbox_events'
         )
       ORDER BY p.proname
    `);
    expect(functions.rows).toEqual([
      {
        proname: "backlink_claim_outbox_events",
        securityDefiner: true,
        config: ["search_path=backlinks, pg_catalog"],
        publicExecute: false,
        writerExecute: true,
      },
      {
        proname: "backlink_claim_recommendation_refill_outbox_events",
        securityDefiner: true,
        config: ["search_path=backlinks, pg_catalog"],
        publicExecute: false,
        writerExecute: true,
      },
    ]);
  });

  it("keeps deferred cutover run lineage forward-upgradeable", async () => {
    const columns = await client.query(`
      SELECT data_type AS "dataType",
             is_nullable AS "isNullable"
        FROM information_schema.columns
       WHERE table_schema='backlinks'
         AND table_name='backlink_recommendation_pool_v2_cutover_control'
         AND column_name='frozen_by_run_id'
    `);
    expect(columns.rows).toEqual([{ dataType: "uuid", isNullable: "YES" }]);

    const runId = uuid("82", ++sequence);
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TABLE backlink_recommendation_pool_v2_cutover_runs (
          id uuid PRIMARY KEY
        )
      `);
      await client.query(
        `INSERT INTO backlink_recommendation_pool_v2_cutover_runs (id)
         VALUES ($1)`,
        [runId],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_pool_v2_cutover_control (
           control_key, state, frozen_by
         ) VALUES ('GLOBAL', 'V1_WRITES_FROZEN', $1)`,
        [actor],
      );
      await client.query(
        `UPDATE backlink_recommendation_pool_v2_cutover_control
            SET frozen_by_run_id=$1
          WHERE control_key='GLOBAL'`,
        [runId],
      );
      await client.query(`
        ALTER TABLE backlink_recommendation_pool_v2_cutover_control
          ALTER COLUMN frozen_by_run_id SET NOT NULL,
          ADD CONSTRAINT backlink_pool_v2_cutover_control_run_fk
          FOREIGN KEY (frozen_by_run_id)
          REFERENCES backlink_recommendation_pool_v2_cutover_runs(id)
      `);

      const constraints = await client.query(`
        SELECT conname
          FROM pg_constraint
         WHERE conrelid =
           'backlinks.backlink_recommendation_pool_v2_cutover_control'::regclass
           AND conname='backlink_pool_v2_cutover_control_run_fk'
      `);
      expect(constraints.rows).toEqual([
        { conname: "backlink_pool_v2_cutover_control_run_fk" },
      ]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("claims an eligible V1 refill and reclaims it when stale", async () => {
    const event = await appendRefill();
    expect((await claim("worker-1")).rows).toHaveLength(1);
    expect(await stored(event.eventId)).toMatchObject({
      status: "processing",
      claimedBy: "worker-1",
      attemptCount: 1,
    });

    expect(
      (await claim("worker-2", undefined, new Date("2999-01-01"))).rows,
    ).toHaveLength(1);
    expect(await stored(event.eventId)).toMatchObject({
      status: "processing",
      claimedBy: "worker-2",
      attemptCount: 2,
    });
  });

  it.each([
    "V2_READY",
    "V2_ACTIVE",
    "MIGRATION_BLOCKED",
    "V2_MAINTENANCE_READ_ONLY",
  ] as const)("leaves a %s project refill untouched", async (state) => {
    const event = await appendRefill(state);
    expect((await claim("worker")).rows).toEqual([]);
    expect(await stored(event.eventId)).toEqual({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      attemptCount: 0,
    });
  });

  it("leaves eligible V1 rows untouched while global writes are frozen", async () => {
    const event = await appendRefill();
    await client.query(
      `INSERT INTO backlink_recommendation_pool_v2_cutover_control (
         control_key, state, frozen_by
       ) VALUES ('GLOBAL', 'V1_WRITES_FROZEN', $1)`,
      [actor],
    );
    expect((await claim("worker")).rows).toEqual([]);
    expect(await stored(event.eventId)).toEqual({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      attemptCount: 0,
    });
  });

  it.each([
    ["malformed payload", { visiblePoolGeneration: "one" }],
    ["mismatched project", { websiteProjectId: uuid("39", 999) }],
    ["mismatched workflow", { workflowId: "wrong-workflow" }],
    ["mismatched refill window", { refillWindowKey: "wrong-window" }],
  ] as const)("leaves %s untouched", async (_label, overrides) => {
    const event = await appendRefill("V1_ACTIVE", overrides);
    expect((await claim("worker")).rows).toEqual([]);
    expect(await stored(event.eventId)).toEqual({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      attemptCount: 0,
    });
  });

  it("keeps the event unchanged when a contract query fails", async () => {
    const event = await appendRefill();
    await client.query("BEGIN");
    try {
      await client.query(
        "ALTER TABLE backlink_recommendation_pool_project_contracts RENAME TO unavailable_project_contracts",
      );
      await expect(claim("worker")).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
    }
    expect(await stored(event.eventId)).toEqual({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      attemptCount: 0,
    });
  });

  it("excludes refill events from the legacy generic claim", async () => {
    const refill = await appendRefill();
    const genericEventId = uuid("47", ++sequence);
    await client.query(
      `INSERT INTO backlink_outbox_events (
         id, organization_id, workspace_id, website_project_id,
         event_type, aggregate_id, aggregate_version, idempotency_key,
         payload, payload_schema_version, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, 'backlinks.project-analysis.requested.v1',
         $5, 1, $6, '{}'::jsonb, 1, $7, $7
       )`,
      [
        genericEventId,
        refill.organizationId,
        refill.workspaceId,
        refill.websiteProjectId,
        uuid("48", sequence),
        `generic-${sequence}`,
        actor,
      ],
    );
    const claimed = await client.query(
      "SELECT event_id AS id FROM backlink_claim_outbox_events($1, 10, NULL, NULL)",
      ["generic-worker"],
    );
    expect(claimed.rows).toEqual([{ id: genericEventId }]);
    expect(await stored(refill.eventId)).toEqual({
      status: "pending",
      claimedAt: null,
      claimedBy: null,
      attemptCount: 0,
    });
  });

  it("allows only one concurrent claimant", async () => {
    const event = await appendRefill();
    const left = new PgClient({ connectionString: harness.connectionString });
    const right = new PgClient({ connectionString: harness.connectionString });
    await Promise.all([left.connect(), right.connect()]);
    try {
      const execute = (connection: Client, workerId: string) =>
        connection.query(
          `SELECT event_id AS id
             FROM backlinks.backlink_claim_recommendation_refill_outbox_events(
               $1, 1, NULL, NULL, NULL, NULL, NULL
             )`,
          [workerId],
        );
      const results = await Promise.all([
        execute(left, "left-worker"),
        execute(right, "right-worker"),
      ]);
      expect(results.flatMap(({ rows }) => rows)).toHaveLength(1);
      expect(await stored(event.eventId)).toMatchObject({
        status: "processing",
        attemptCount: 1,
      });
    } finally {
      await Promise.all([left.end(), right.end()]);
    }
  });
});
