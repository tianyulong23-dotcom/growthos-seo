import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyBacklinksDeploymentManifest } from "../../../src/modules/backlinks/db/deployment-manifest-runner.mjs";
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

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const devUpUrl = new URL("../../../../../scripts/dev-up.ps1", import.meta.url);
const freshDatabase = "backlinks_manifest_fresh";
const upgradeTemplateDatabase = "backlinks_manifest_upgrade_template";
const frozenUpgradeDatabase = "backlinks_manifest_upgrade_frozen";
const unfrozenUpgradeDatabase = "backlinks_manifest_upgrade_unfrozen";

function databaseUrl(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connectDatabase(
  connectionString: string,
  database: string,
): Promise<Client> {
  const client = new PgClient({
    connectionString: databaseUrl(connectionString, database),
  });
  await client.connect();
  return client;
}

async function installDatabasePrerequisites(client: Client): Promise<void> {
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
}

async function insertNonPristineFact(client: Client, suffix: string) {
  await client.query(
    `INSERT INTO backlinks.backlink_idempotency_records (
       id,
       organization_id,
       workspace_id,
       website_project_id,
       idempotency_key,
       command_type,
       request_hash,
       expires_at,
       created_by,
       updated_by
     ) VALUES (
       $1,
       '019b0000-0000-7000-8000-000000000002',
       '019b0000-0000-7000-8000-000000000003',
       '019b0000-0000-7000-8000-000000000004',
       $2,
       'manifest-upgrade-fixture',
       'manifest-upgrade-request-hash',
       now() + interval '1 hour',
       'manifest-upgrade-test',
       'manifest-upgrade-test'
     )`,
    [
      `019b0000-0000-7000-8000-${suffix.padStart(12, "0")}`,
      `manifest-upgrade-${suffix}`,
    ],
  );
}

async function establishValidFreeze(client: Client): Promise<void> {
  await client.query(`
    DO $freeze$
    DECLARE
      verification jsonb;
      phase9_run jsonb;
    BEGIN
      verification :=
        backlinks.backlink_recommendation_pool_v2_verify_cutover();
      IF NOT COALESCE((verification->>'completed')::boolean, false) THEN
        RAISE EXCEPTION 'Upgrade fixture cutover is not ready: %', verification;
      END IF;

      PERFORM *
        FROM backlinks.backlink_recommendation_pool_v2_start_cutover_run(
          '019b0000-0000-7000-8000-000000000010'::uuid,
          'manifest-upgrade-test:valid-cutover.v1',
          'EXECUTE',
          'manifest-upgrade-test'
        );
      PERFORM backlinks.backlink_recommendation_pool_v2_finish_cutover_run(
        '019b0000-0000-7000-8000-000000000010'::uuid,
        'COMPLETED',
        COALESCE((verification->>'eligibleProjectCount')::integer, 0),
        COALESCE((verification->>'v2ActiveProjectCount')::integer, 0),
        0,
        COALESCE(
          (verification->>'migrationBlockedProjectCount')::integer,
          0
        ),
        verification,
        'manifest-upgrade-test',
        statement_timestamp()
      );
      phase9_run :=
        backlinks.backlink_recommendation_pool_v2_phase9_run(
          '019b0000-0000-7000-8000-000000000011'::uuid,
          'manifest-upgrade-test:valid-freeze.v1',
          'EXECUTE',
          'manifest-upgrade-test',
          statement_timestamp()
        );
      IF phase9_run->>'status' <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Upgrade fixture freeze failed: %', phase9_run;
      END IF;
    END;
    $freeze$;
  `);
}

async function upgradeState(client: Client): Promise<Record<string, unknown>> {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::integer
         FROM backlinks.backlink_idempotency_records) AS idempotency_count,
      (SELECT count(*)::integer
         FROM backlinks.backlink_recommendation_pool_v2_cutover_runs)
        AS cutover_run_count,
      (SELECT count(*)::integer
         FROM backlinks.backlink_recommendation_pool_v2_phase9_runs)
        AS phase9_run_count,
      (SELECT count(*)::integer
         FROM backlinks.backlink_recommendation_pool_v2_cutover_control)
        AS control_count,
      pg_catalog.to_regprocedure(
        'backlinks.backlink_pool_v2_candidate_fact_reconciliation_verify()'
      ) IS NOT NULL AS reconciliation_installed,
      (SELECT class.relforcerowsecurity
         FROM pg_catalog.pg_class AS class
        WHERE class.oid =
          'backlinks.backlink_recommendation_pool_project_contracts'
            ::regclass) AS project_contract_force_rls
  `);
  return result.rows[0] ?? {};
}

describe("Backlinks deployment manifest fresh and upgrade execution", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let fresh: Client;
  let frozenUpgrade: Client;
  let unfrozenUpgrade: Client;
  let freshSearchPathBefore = "";

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    admin = await connectDatabase(harness.connectionString, "postgres");
    await admin.query(`CREATE DATABASE ${freshDatabase}`);
    await admin.query(`CREATE DATABASE ${upgradeTemplateDatabase}`);

    fresh = await connectDatabase(harness.connectionString, freshDatabase);
    await installDatabasePrerequisites(fresh);
    freshSearchPathBefore = String(
      (
        await fresh.query(
          "SELECT current_setting('search_path') AS search_path",
        )
      ).rows[0]?.search_path,
    );
    await applyBacklinksDeploymentManifest({
      query: (sql) => fresh.query(sql),
      startRevision: "0001",
      targetRevision: "0095",
    });

    const upgradeTemplate = await connectDatabase(
      harness.connectionString,
      upgradeTemplateDatabase,
    );
    await installDatabasePrerequisites(upgradeTemplate);
    await applyBacklinksDeploymentManifest({
      query: (sql) => upgradeTemplate.query(sql),
      startRevision: "0001",
      targetRevision: "0092",
    });
    await upgradeTemplate.end();

    await admin.query(
      `CREATE DATABASE ${frozenUpgradeDatabase} ` +
        `TEMPLATE ${upgradeTemplateDatabase}`,
    );
    await admin.query(
      `CREATE DATABASE ${unfrozenUpgradeDatabase} ` +
        `TEMPLATE ${upgradeTemplateDatabase}`,
    );
    frozenUpgrade = await connectDatabase(
      harness.connectionString,
      frozenUpgradeDatabase,
    );
    unfrozenUpgrade = await connectDatabase(
      harness.connectionString,
      unfrozenUpgradeDatabase,
    );
  }, 300_000);

  afterAll(async () => {
    await unfrozenUpgrade?.end();
    await frozenUpgrade?.end();
    await fresh?.end();
    if (admin) {
      for (const database of [
        frozenUpgradeDatabase,
        unfrozenUpgradeDatabase,
        upgradeTemplateDatabase,
        freshDatabase,
      ]) {
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
      await admin.end();
    }
    await harness?.stop();
  }, 60_000);

  it("installs a pristine database through head with durable audited freeze", async () => {
    const state = (
      await fresh.query(`
        SELECT
          current_setting('search_path') AS search_path,
          backlinks.backlink_phase9_v1_writes_are_frozen() AS frozen,
          backlinks.backlink_pool_v2_candidate_fact_reconciliation_verify()
            AS reconciliation,
          (SELECT count(*)::integer
             FROM backlinks.backlink_recommendation_pool_v2_cutover_control)
            AS control_count,
          (SELECT count(*)::integer
             FROM backlinks.backlink_recommendation_pool_v2_cutover_runs
            WHERE id =
              '00000000-0000-7000-8000-000000000093'::uuid
              AND status = 'COMPLETED'
              AND verification->>'freshInstallBootstrap' = 'true')
            AS bootstrap_cutover_count,
          (SELECT count(*)::integer
             FROM backlinks.backlink_recommendation_pool_v2_phase9_runs
            WHERE id =
              '00000000-0000-7000-8000-000000000193'::uuid
              AND status = 'COMPLETED')
            AS bootstrap_phase9_count
      `)
    ).rows[0];
    expect(state).toMatchObject({
      search_path: freshSearchPathBefore,
      frozen: true,
      control_count: 1,
      bootstrap_cutover_count: 1,
      bootstrap_phase9_count: 1,
    });
    expect(state?.reconciliation).toMatchObject({
      candidateFactReconciliationInstalled: true,
      projectContractsForceRls: true,
      generationContractsForceRls: true,
      inputPinsForceRls: true,
      v1WritesFrozen: true,
    });

    const security = (
      await fresh.query(`
        WITH target_function AS (
          SELECT function.oid, function.proacl, function.proowner
            FROM pg_catalog.pg_proc AS function
           WHERE function.oid =
             'backlinks.backlink_pool_v2_candidate_fact_reconciliation_verify()'
               ::regprocedure
        ),
        privileges AS (
          SELECT acl.grantee, acl.privilege_type
            FROM target_function
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                target_function.proacl,
                pg_catalog.acldefault('f', target_function.proowner)
              )
            ) AS acl
        )
        SELECT
          NOT EXISTS (
            SELECT 1
              FROM privileges
             WHERE grantee = 0
               AND privilege_type = 'EXECUTE'
          ) AS public_execute_revoked,
          EXISTS (
            SELECT 1
              FROM privileges
              JOIN pg_catalog.pg_roles AS role
                ON role.oid = privileges.grantee
             WHERE role.rolname = 'growthos_backlinks_writer'
               AND privileges.privilege_type = 'EXECUTE'
          ) AS writer_execute_granted,
          EXISTS (
            SELECT 1
              FROM privileges
              JOIN pg_catalog.pg_roles AS role
                ON role.oid = privileges.grantee
             WHERE role.rolname = 'growthos_reporting_reader'
               AND privileges.privilege_type = 'EXECUTE'
          ) AS reporting_execute_granted,
          count(*) FILTER (
            WHERE class.relrowsecurity AND class.relforcerowsecurity
          )::integer AS force_rls_count
        FROM pg_catalog.pg_class AS class
        WHERE class.oid IN (
          'backlinks.backlink_recommendation_pool_project_contracts'
            ::regclass,
          'backlinks.backlink_recommendation_generation_contracts'
            ::regclass,
          'backlinks.backlink_generation_input_pins'::regclass
        )
        GROUP BY
          public_execute_revoked,
          writer_execute_granted,
          reporting_execute_granted
      `)
    ).rows[0];
    expect(security).toEqual({
      public_execute_revoked: true,
      writer_execute_granted: true,
      reporting_execute_granted: true,
      force_rls_count: 3,
    });

    const contactRecoverySecurity = (
      await fresh.query(`
        WITH target_function AS (
          SELECT function.oid, function.proacl, function.proowner,
                 function.prosecdef, function.proconfig
            FROM pg_catalog.pg_proc AS function
           WHERE function.oid =
             'backlinks.backlink_list_contact_enrichment_recovery_scopes(integer)'
               ::regprocedure
        ),
        privileges AS (
          SELECT acl.grantee, acl.privilege_type
            FROM target_function
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                target_function.proacl,
                pg_catalog.acldefault('f', target_function.proowner)
              )
            ) AS acl
        ),
        policies AS (
          SELECT policy.tablename, policy.cmd, policy.roles, policy.qual
            FROM pg_catalog.pg_policies AS policy
           WHERE policy.schemaname = 'backlinks'
              AND policy.policyname IN (
                'backlink_contact_recovery_job_read_policy',
                'backlink_contact_recovery_inventory_read_policy',
                'backlink_contact_recovery_recommendation_read_policy',
                'backlink_contact_recovery_candidate_read_policy',
                'backlink_contact_recovery_evidence_read_policy'
              )
        )
        SELECT
          (SELECT role.rolname
             FROM target_function
             JOIN pg_catalog.pg_roles AS role
               ON role.oid = target_function.proowner) AS function_owner,
          (SELECT target_function.prosecdef FROM target_function)
            AS security_definer,
          (SELECT target_function.proconfig FROM target_function)
            AS function_config,
          NOT EXISTS (
            SELECT 1
              FROM privileges
             WHERE grantee = 0
               AND privilege_type = 'EXECUTE'
          ) AS public_execute_revoked,
          EXISTS (
            SELECT 1
              FROM privileges
              JOIN pg_catalog.pg_roles AS role
                ON role.oid = privileges.grantee
             WHERE role.rolname = 'growthos_backlinks_writer'
               AND privileges.privilege_type = 'EXECUTE'
          ) AS writer_execute_granted,
          (SELECT count(*)::integer FROM policies) AS policy_count,
          NOT EXISTS (
            SELECT 1
              FROM policies
             WHERE cmd <> 'SELECT'
                OR roles <> ARRAY['growthos_backlinks_owner']::name[]
                OR qual <> 'true'
          ) AS policies_are_owner_select_only,
          (SELECT count(*)::integer
             FROM pg_catalog.pg_class AS class
            WHERE class.oid IN (
              'backlinks.backlink_contact_enrichment_jobs'::regclass,
              'backlinks.backlink_recommendation_inventory'::regclass,
              'backlinks.backlink_recommendations'::regclass,
              'backlinks.backlink_contact_candidates'::regclass,
              'backlinks.backlink_contact_evidence'::regclass
            )
              AND class.relrowsecurity
              AND class.relforcerowsecurity) AS force_rls_count
      `)
    ).rows[0];
    expect(contactRecoverySecurity).toEqual({
      function_owner: "growthos_backlinks_owner",
      security_definer: true,
      function_config: ["search_path=backlinks, pg_catalog"],
      public_execute_revoked: true,
      writer_execute_granted: true,
      policy_count: 5,
      policies_are_owner_select_only: true,
      force_rls_count: 5,
    });

    const beforeRerun = await upgradeState(fresh);
    await applyBacklinksDeploymentManifest({
      query: (sql) => fresh.query(sql),
      startRevision: "0095",
      targetRevision: "0095",
    });
    expect(await upgradeState(fresh)).toEqual(beforeRerun);
  });

  it("permits a non-pristine upgrade only after a valid durable freeze", async () => {
    await insertNonPristineFact(frozenUpgrade, "20");
    await establishValidFreeze(frozenUpgrade);
    await applyBacklinksDeploymentManifest({
      query: (sql) => frozenUpgrade.query(sql),
      startRevision: "0093",
      targetRevision: "0093",
    });

    expect(await upgradeState(frozenUpgrade)).toMatchObject({
      idempotency_count: 1,
      cutover_run_count: 1,
      phase9_run_count: 1,
      control_count: 1,
      reconciliation_installed: true,
      project_contract_force_rls: true,
    });
  });

  it("rejects a non-pristine unfrozen upgrade before any mutation", async () => {
    await insertNonPristineFact(unfrozenUpgrade, "30");
    const before = await upgradeState(unfrozenUpgrade);

    await expect(
      applyBacklinksDeploymentManifest({
        query: (sql) => unfrozenUpgrade.query(sql),
        startRevision: "0093",
        targetRevision: "0093",
      }),
    ).rejects.toThrow(
      "BACKLINKS_0093_FRESH_BOOTSTRAP_REQUIRES_PRISTINE_DATABASE",
    );
    expect(await upgradeState(unfrozenUpgrade)).toEqual(before);
  });

  it("detects the 0095 production head before 0094 and immutable 0093", async () => {
    const source = await readFile(devUpUrl, "utf8");
    const head0095 = source.indexOf("THEN '0095'");
    const head0094 = source.indexOf("THEN '0094'");
    const head0093 = source.indexOf("THEN '0093'");

    expect(head0095).toBeGreaterThan(-1);
    expect(head0094).toBeGreaterThan(-1);
    expect(head0095).toBeLessThan(head0094);
    expect(head0094).toBeLessThan(head0093);
    expect(source).toContain("backlink_contact_recovery_job_read_policy");
    expect(source).toContain("backlink_contact_recovery_inventory_read_policy");
    expect(source).toContain(
      "backlink_contact_recovery_recommendation_read_policy",
    );
    expect(source).toContain(
      "backlink_contact_recovery_candidate_read_policy",
    );
    expect(source).toContain(
      "backlink_contact_recovery_evidence_read_policy",
    );
  });
});
