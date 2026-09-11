import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInventoryMonitorRepository } from "../../../src/modules/backlinks/application/repositories/inventory-monitor.repository.js";
import {
  createBacklinkProfileService,
  createBacklinkProfileStore,
} from "../../../src/modules/backlinks/application/services/backlink-profile.service.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
type Pool = BacklinkTenantPool & Readonly<{ end(): Promise<void> }>;
const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => Pool;
};

describe("LOCAL-PRODUCT-020 backlink profile inventory migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: Pool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await installBacklinksManifestAfterFoundation(client);
    pool = new PgPool({
      connectionString: harness.connectionString,
      max: 4,
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("creates the seven profile and inventory entities with forced RLS", async () => {
    const names = [
      "backlink_inventory_items",
      "backlink_inventory_observations",
      "backlink_profile_health_snapshots",
      "backlink_profile_provider_artifacts",
      "backlink_profile_snapshots",
      "backlink_profile_sync_cursors",
      "backlink_profile_sync_jobs",
    ];
    expect(
      (
        await client.query(
          `SELECT relname,relrowsecurity,relforcerowsecurity
         FROM pg_class
        WHERE relnamespace='backlinks'::regnamespace
          AND relname=ANY($1::text[])
        ORDER BY relname`,
          [names],
        )
      ).rows,
    ).toEqual(
      names.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  it("keeps provider total and inventory coverage separate", async () => {
    expect(
      (
        await client.query(
          `SELECT column_name AS "columnName"
         FROM information_schema.columns
        WHERE table_schema='backlinks'
          AND table_name='backlink_profile_snapshots'
          AND column_name IN (
            'total_backlinks','inventory_pulled_count','inventory_coverage',
            'unavailable_metrics'
          )
        ORDER BY column_name`,
        )
      ).rows,
    ).toEqual([
      { columnName: "inventory_coverage" },
      { columnName: "inventory_pulled_count" },
      { columnName: "total_backlinks" },
      { columnName: "unavailable_metrics" },
    ]);
  });

  it("deduplicates inventory by normalized source, target, and provider identity", async () => {
    const constraints = await client.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid='backlinks.backlink_inventory_items'::regclass
          AND conname='backlink_inventory_item_provider_identity_uq'`,
    );
    expect(constraints.rows).toEqual([
      {
        conname: "backlink_inventory_item_provider_identity_uq",
      },
    ]);
  });

  it("creates forced-RLS monitoring entities with immutable direct evidence", async () => {
    const names = [
      "backlink_inventory_monitor_observations",
      "backlink_inventory_monitor_policies",
      "backlink_inventory_monitor_requests",
      "backlink_inventory_monitor_runs",
    ];
    expect(
      (
        await client.query(
          `SELECT relname,relrowsecurity,relforcerowsecurity
         FROM pg_class
        WHERE relnamespace='backlinks'::regnamespace
          AND relname=ANY($1::text[])
        ORDER BY relname`,
          [names],
        )
      ).rows,
    ).toEqual(
      names.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );

    expect(
      (
        await client.query(
          `SELECT tgname
         FROM pg_trigger
        WHERE tgrelid='backlinks.backlink_inventory_monitor_observations'::regclass
          AND NOT tgisinternal
        ORDER BY tgname`,
        )
      ).rows,
    ).toContainEqual({
      tgname: "backlink_inventory_monitor_observation_immutable",
    });
  });

  it("assigns deterministic tiers without treating provider lost as direct lost", async () => {
    await client.query(`
      INSERT INTO backlinks.backlink_inventory_items (
        id, organization_id, workspace_id, website_project_id,
        source_type, provider, provider_identity,
        normalized_source_url, normalized_target_url, source_domain,
        provider_status, rank, managed, created_by, updated_by
      )
      VALUES
        (
          '51000000-0000-4000-8000-000000000001',
          '51000000-0000-4000-8000-000000000010',
          '51000000-0000-4000-8000-000000000020',
          '51000000-0000-4000-8000-000000000030',
          'USER_IMPORTED', 'user_import', 'managed-a',
          'https://managed.example.test/post',
          'https://owner.example.test/a',
          'managed.example.test', 'unknown', 10, true,
          'migration-test', 'migration-test'
        ),
        (
          '51000000-0000-4000-8000-000000000002',
          '51000000-0000-4000-8000-000000000010',
          '51000000-0000-4000-8000-000000000020',
          '51000000-0000-4000-8000-000000000030',
          'DATAFORSEO', 'dataforseo', 'rank-b',
          'https://quality.example.test/post',
          'https://owner.example.test/b',
          'quality.example.test', 'live', 70, false,
          'migration-test', 'migration-test'
        ),
        (
          '51000000-0000-4000-8000-000000000003',
          '51000000-0000-4000-8000-000000000010',
          '51000000-0000-4000-8000-000000000020',
          '51000000-0000-4000-8000-000000000030',
          'DATAFORSEO', 'dataforseo', 'long-tail-c',
          'https://tail.example.test/post',
          'https://owner.example.test/c',
          'tail.example.test', 'live', 20, false,
          'migration-test', 'migration-test'
        ),
        (
          '51000000-0000-4000-8000-000000000004',
          '51000000-0000-4000-8000-000000000010',
          '51000000-0000-4000-8000-000000000020',
          '51000000-0000-4000-8000-000000000030',
          'DATAFORSEO', 'dataforseo', 'provider-lost-a',
          'https://provider-lost.example.test/post',
          'https://owner.example.test/d',
          'provider-lost.example.test', 'lost', 20, false,
          'migration-test', 'migration-test'
        ),
        (
          '51000000-0000-4000-8000-000000000005',
          '51000000-0000-4000-8000-000000000010',
          '51000000-0000-4000-8000-000000000020',
          '51000000-0000-4000-8000-000000000031',
          'DATAFORSEO', 'dataforseo', 'cross-project-copy',
          'https://tail.example.test/post',
          'https://owner.example.test/c',
          'tail.example.test', 'live', 20, false,
          'migration-test', 'migration-test'
        );
    `);

    expect(
      (
        await client.query(
          `SELECT
         inventory.provider_identity AS "providerIdentity",
         inventory.provider_status AS "providerStatus",
         inventory.direct_validation_status AS "directStatus",
         policy.tier,
         policy.monitoring_status AS "monitoringStatus",
         policy.normal_interval_seconds AS "normalIntervalSeconds",
         policy.policy_version AS "policyVersion",
         policy.next_check_at IS NOT NULL AS "hasNextCheck",
         policy.provider_only_reason AS "providerOnlyReason"
       FROM backlinks.backlink_inventory_items inventory
       JOIN backlinks.backlink_inventory_monitor_policies policy
         ON policy.organization_id=inventory.organization_id
        AND policy.workspace_id=inventory.workspace_id
        AND policy.website_project_id=inventory.website_project_id
        AND policy.inventory_item_id=inventory.id
       WHERE inventory.organization_id=
         '51000000-0000-4000-8000-000000000010'
       ORDER BY inventory.provider_identity`,
        )
      ).rows,
    ).toEqual([
      {
        providerIdentity: "cross-project-copy",
        providerStatus: "live",
        directStatus: "UNVERIFIED",
        tier: "C",
        monitoringStatus: "provider_only",
        normalIntervalSeconds: 2_592_000,
        policyVersion: "inventory-monitoring-v1",
        hasNextCheck: false,
        providerOnlyReason: "provider_inventory_requires_pin_or_management",
      },
      {
        providerIdentity: "long-tail-c",
        providerStatus: "live",
        directStatus: "UNVERIFIED",
        tier: "C",
        monitoringStatus: "provider_only",
        normalIntervalSeconds: 2_592_000,
        policyVersion: "inventory-monitoring-v1",
        hasNextCheck: false,
        providerOnlyReason: "provider_inventory_requires_pin_or_management",
      },
      {
        providerIdentity: "managed-a",
        providerStatus: "unknown",
        directStatus: "UNVERIFIED",
        tier: "A",
        monitoringStatus: "enabled",
        normalIntervalSeconds: 86_400,
        policyVersion: "inventory-monitoring-v1",
        hasNextCheck: true,
        providerOnlyReason: null,
      },
      {
        providerIdentity: "provider-lost-a",
        providerStatus: "lost",
        directStatus: "UNVERIFIED",
        tier: "A",
        monitoringStatus: "provider_only",
        normalIntervalSeconds: 86_400,
        policyVersion: "inventory-monitoring-v1",
        hasNextCheck: false,
        providerOnlyReason: "provider_inventory_requires_pin_or_management",
      },
      {
        providerIdentity: "rank-b",
        providerStatus: "live",
        directStatus: "UNVERIFIED",
        tier: "B",
        monitoringStatus: "provider_only",
        normalIntervalSeconds: 604_800,
        policyVersion: "inventory-monitoring-v1",
        hasNextCheck: false,
        providerOnlyReason: "provider_inventory_requires_pin_or_management",
      },
    ]);

    await client.query("SET search_path = backlinks, pg_catalog");
    const store = createBacklinkProfileStore(client, {
      providerEnabled: false,
      providerAvailable: false,
      estimatedCostMicros: 0,
    });
    const context = {
      actor: createActorContext({
        userId: "migration-test",
        sessionId: "migration-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: "51000000-0000-4000-8000-000000000010",
        workspaceId: "51000000-0000-4000-8000-000000000020",
      }),
      project: createProjectContext({
        websiteProjectId: "51000000-0000-4000-8000-000000000030",
        canonicalDomain: "owner.example.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
      }),
    };
    const pinned = await store.updateInventoryPolicy(
      context,
      "51000000-0000-4000-8000-000000000002",
      {
        expectedVersion: 1,
        important: true,
        monitoringStatus: "enabled",
      },
    );
    expect(pinned).toMatchObject({
      inventoryItemId: "51000000-0000-4000-8000-000000000002",
      tier: "A",
      importance: "important",
      monitoringStatus: "enabled",
      providerOnlyReason: null,
    });
    expect(pinned.nextCheckAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(String(pinned.nextCheckAt)))).toBe(false);
    expect(
      (
        await client.query(`
      SELECT pinned
        FROM backlinks.backlink_inventory_items
       WHERE id='51000000-0000-4000-8000-000000000002'
    `)
      ).rows,
    ).toEqual([{ pinned: true }]);

    await expect(
      client.query(`
      INSERT INTO backlinks.backlink_inventory_items (
        id, organization_id, workspace_id, website_project_id,
        source_type, provider, provider_identity,
        normalized_source_url, normalized_target_url, source_domain,
        provider_status, created_by, updated_by
      )
      VALUES (
        '51000000-0000-4000-8000-000000000006',
        '51000000-0000-4000-8000-000000000010',
        '51000000-0000-4000-8000-000000000020',
        '51000000-0000-4000-8000-000000000030',
        'USER_IMPORTED', 'user_import', 'same-pair-different-provider',
        'https://tail.example.test/post',
        'https://owner.example.test/c',
        'tail.example.test', 'unknown',
        'migration-test', 'migration-test'
      );
    `),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "backlink_inventory_item_canonical_urls_uq",
    });
  });

  it("prepares an inventory run across PostgreSQL microsecond precision", async () => {
    const organizationId = "52000000-0000-4000-8000-000000000010";
    const workspaceId = "52000000-0000-4000-8000-000000000020";
    const websiteProjectId = "52000000-0000-4000-8000-000000000030";
    const inventoryItemId = "52000000-0000-4000-8000-000000000040";
    const runId = "52000000-0000-4000-8000-000000000050";

    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `
      INSERT INTO backlink_project_context_snapshots (
        id, organization_id, workspace_id, website_project_id,
        snapshot_version, project_status, canonical_domain, locale,
        country_code, products, keywords, target_urls,
        profile_version_id, promotion_target_version_id, created_by
      ) VALUES (
        '52000000-0000-4000-8000-000000000031',
        $1, $2, $3, 1, 'ACTIVE', 'owner.example.test', 'en-US', 'US',
        '[]'::jsonb, '[]'::jsonb,
        '["https://owner.example.test/target"]'::jsonb,
        'profile-v1', 'promotion-target-v1', 'migration-test'
      );
    `,
      [organizationId, workspaceId, websiteProjectId],
    );
    await client.query(
      `
      INSERT INTO backlink_inventory_items (
        id, organization_id, workspace_id, website_project_id,
        source_type, provider, provider_identity,
        normalized_source_url, normalized_target_url, source_domain,
        provider_status, managed, created_by, updated_by
      ) VALUES (
        $4, $1, $2, $3,
        'USER_IMPORTED', 'user_import', 'prepare-regression',
        'https://source.example.test/post',
        'https://owner.example.test/target',
        'source.example.test', 'unknown', true,
        'migration-test', 'migration-test'
      );
    `,
      [organizationId, workspaceId, websiteProjectId, inventoryItemId],
    );
    await client.query(
      `
      UPDATE backlink_inventory_monitor_policies
         SET next_check_at='2026-08-07T00:00:00.000907Z'
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND inventory_item_id=$4
    `,
      [organizationId, workspaceId, websiteProjectId, inventoryItemId],
    );

    const policy = (
      await client.query(
        `
      SELECT id, next_check_at AS "nextCheckAt"
        FROM backlink_inventory_monitor_policies
       WHERE organization_id=$1 AND workspace_id=$2
         AND website_project_id=$3 AND inventory_item_id=$4
    `,
        [organizationId, workspaceId, websiteProjectId, inventoryItemId],
      )
    ).rows[0];
    expect(policy).toBeDefined();

    const prepared = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      async (transaction) => {
        await transaction.query(
          "SET LOCAL search_path = backlinks, pg_catalog",
        );
        expect(
          (
            await transaction.query(
              `SELECT
             backlink_phase9_job_is_v1(
               jsonb_build_object(
                 'organization_id', $1::text,
                 'workspace_id', $2::text,
                 'website_project_id', $3::text,
                 'job_type', 'backlink_inventory_monitor',
                 'source_object_type', 'backlink_inventory_item',
                 'source_object_id', $4::text
               )
             ) AS "isV1",
             EXISTS (
               SELECT 1
                 FROM backlink_inventory_items item
                WHERE item.organization_id=$1::uuid
                  AND item.workspace_id=$2::uuid
                  AND item.website_project_id=$3::uuid
                  AND item.id=$4::uuid
             ) AS "inventoryExists"`,
              [organizationId, workspaceId, websiteProjectId, inventoryItemId],
            )
          ).rows,
        ).toEqual([{ isV1: false, inventoryExists: true }]);

        return createInventoryMonitorRepository(transaction).prepare({
          organizationId,
          workspaceId,
          websiteProjectId,
          placementId: inventoryItemId,
          monitorPolicyId: String(policy?.id),
          policyVersion: "inventory-monitoring-v1",
          scheduledFor: new Date("2026-08-07T00:00:00.000Z"),
          runId,
          workerId: "migration-test",
          now: new Date("2026-08-07T00:00:00.000Z"),
        });
      },
    );

    expect(prepared.state).toBe("ready");
    if (prepared.state !== "ready") {
      throw new Error("Expected the Inventory Monitor Run to be ready.");
    }
    expect(
      (
        await client.query(
          `
      SELECT run.status, job.correlation_id AS "correlationId"
        FROM backlink_inventory_monitor_runs run
        JOIN backlink_jobs job ON job.id=run.backlink_job_id
       WHERE run.id=$1
    `,
          [runId],
        )
      ).rows,
    ).toEqual([
      {
        status: "RUNNING",
        correlationId: runId,
      },
    ]);

    const completed = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      async (transaction) => {
        await transaction.query(
          "SET LOCAL search_path = backlinks, pg_catalog",
        );
        return createInventoryMonitorRepository(transaction).complete({
          organizationId,
          workspaceId,
          websiteProjectId,
          placementId: inventoryItemId,
          monitorPolicyId: String(policy?.id),
          policyVersion: "inventory-monitoring-v1",
          scheduledFor: prepared.execution.scheduledFor,
          runId,
          expectedAttemptCount: prepared.execution.attemptCount,
          observationId: "52000000-0000-4000-8000-000000000060",
          expectedPlacementVersion: prepared.execution.placementVersion,
          expectedHealthStatus: prepared.execution.healthStatus,
          statusDecision: {
            policyVersion: "placement-monitoring-status.v1",
            nextHealthStatus: "active",
            confirmationType: null,
            matchingEvidenceCount: 0,
            requiredConfirmationCount: null,
            reasonCode: "PLACEMENT_PRESENT",
            shouldRecheckSoon: false,
          },
          decisionFactId: "52000000-0000-4000-8000-000000000070",
          lossConfirmationCount: 2,
          changeConfirmationCount: 2,
          recoveryProjection: null,
          observation: {
            result: "present",
            failureCode: null,
            retryable: false,
            evidenceSnapshot: { result: "present", targetFound: true },
            evidenceSnapshotHash: "a".repeat(64),
            evidenceFingerprint: "b".repeat(64),
            evidenceContractVersion: "placement.monitor-observation.v1",
            evidenceSchemaVersion: 1,
            observedAt: new Date("2026-08-07T00:00:01.000Z"),
          },
          terminalStatus: "SUCCEEDED",
          nextCheckAt: new Date("2026-08-08T00:00:00.000Z"),
          workerId: "migration-test",
          completedAt: new Date("2026-08-07T00:00:02.000Z"),
        });
      },
    );

    expect(completed).toMatchObject({
      runId,
      status: "SUCCEEDED",
      observationResult: "present",
    });
    expect(
      (
        await client.query(
          `
      SELECT run.status, observation.result,
             policy.next_check_at AS "nextCheckAt"
        FROM backlink_inventory_monitor_runs run
        JOIN backlink_inventory_monitor_observations observation
          ON observation.monitor_run_id=run.id
        JOIN backlink_inventory_monitor_policies policy
          ON policy.id=run.monitor_policy_id
       WHERE run.id=$1
    `,
          [runId],
        )
      ).rows,
    ).toEqual([
      {
        status: "SUCCEEDED",
        result: "present",
        nextCheckAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    ]);
  });

  it("lists inventory through the real policy join", async () => {
    const organizationId = "53000000-0000-4000-8000-000000000010";
    const workspaceId = "53000000-0000-4000-8000-000000000020";
    const websiteProjectId = "53000000-0000-4000-8000-000000000030";
    const inventoryItemId = "53000000-0000-4000-8000-000000000040";

    await client.query(
      `
      INSERT INTO backlinks.backlink_inventory_items (
        id, organization_id, workspace_id, website_project_id,
        source_type, provider, provider_identity,
        normalized_source_url, normalized_target_url, source_domain,
        provider_status, managed, created_by, updated_by
      ) VALUES (
        $4, $1, $2, $3,
        'USER_IMPORTED', 'user_import', 'list-regression',
        'https://list.example.test/post',
        'https://owner.example.test/target',
        'list.example.test', 'unknown', true,
        'migration-test', 'migration-test'
      );
    `,
      [organizationId, workspaceId, websiteProjectId, inventoryItemId],
    );

    const store = createBacklinkProfileStore(client, {
      providerEnabled: false,
      providerAvailable: false,
      estimatedCostMicros: 0,
    });
    const page = await store.listInventory(
      {
        actor: createActorContext({
          userId: "migration-test",
          sessionId: "migration-test",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "owner.example.test",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-v1",
          promotionTargetVersionId: "promotion-v1",
        }),
      },
      {
        page: 1,
        pageSize: 25,
        sort: "last_seen_desc",
      },
    );

    expect(page).toMatchObject({
      totalCount: 1,
      totalPages: 1,
      items: [
        {
          inventoryItemId,
          sourceUrl: "https://list.example.test/post",
          targetUrl: "https://owner.example.test/target",
          tier: "A",
          monitoringStatus: "enabled",
        },
      ],
    });
  });

  it("lists the latest project inventory by category without cross-project leakage", async () => {
    const organizationId = "54000000-0000-4000-8000-000000000010";
    const workspaceId = "54000000-0000-4000-8000-000000000020";
    const projectAId = "54000000-0000-4000-8000-000000000030";
    const projectBId = "54000000-0000-4000-8000-000000000031";
    const oldSnapshotAId = "54000000-0000-4000-8000-000000000041";
    const latestSnapshotAId = "54000000-0000-4000-8000-000000000042";
    const latestSnapshotBId = "54000000-0000-4000-8000-000000000043";
    const itemIds = {
      sharedNew: "54000000-0000-4000-8000-000000000051",
      sharedLost: "54000000-0000-4000-8000-000000000052",
      oldOnly: "54000000-0000-4000-8000-000000000053",
      currentObserved: "54000000-0000-4000-8000-000000000054",
      projectBNew: "54000000-0000-4000-8000-000000000055",
    } as const;
    const store = createBacklinkProfileStore(client, {
      providerEnabled: false,
      providerAvailable: true,
      estimatedCostMicros: 0,
    });
    const context = (websiteProjectId: string, canonicalDomain: string) => ({
      actor: createActorContext({
        userId: "migration-test",
        sessionId: "migration-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain,
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
      }),
    });
    const contextA = context(projectAId, "project-a.example.test");
    const contextB = context(projectBId, "project-b.example.test");
    const jobA = await store.createSyncJob(contextA, {
      idempotencyKey: "inventory-view-project-a",
    });
    const jobB = await store.createSyncJob(contextB, {
      idempotencyKey: "inventory-view-project-b",
    });

    const insertSnapshot = async (
      websiteProjectId: string,
      profileSyncJobId: string,
      snapshotId: string,
      observedAt: string,
    ) => {
      await client.query(
        `
        INSERT INTO backlinks.backlink_profile_snapshots (
          id,organization_id,workspace_id,website_project_id,
          profile_sync_job_id,provider,endpoints,provider_task_ids,
          observed_at,fresh_until,freshness,completeness,
          total_backlinks,referring_domains,new_backlinks,lost_backlinks,
          inventory_pulled_count,inventory_coverage,distributions,
          unavailable_metrics,cost_micros,schema_version,next_sync_at,created_by
        ) VALUES (
          $4,$1,$2,$3,$5,'user_import','[]'::jsonb,'[]'::jsonb,
          $6::timestamptz,$6::timestamptz + interval '7 days','fresh','full',
          4,3,1,1,4,1,'{}'::jsonb,'[]'::jsonb,0,
          'backlink-profile.v1',$6::timestamptz + interval '7 days',
          'migration-test'
        )
      `,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          snapshotId,
          profileSyncJobId,
          observedAt,
        ],
      );
    };
    await insertSnapshot(
      projectAId,
      jobA.jobId,
      oldSnapshotAId,
      "2026-08-06T00:00:00.000Z",
    );
    await insertSnapshot(
      projectAId,
      jobA.jobId,
      latestSnapshotAId,
      "2026-08-07T00:00:00.000Z",
    );
    await insertSnapshot(
      projectBId,
      jobB.jobId,
      latestSnapshotBId,
      "2026-08-08T00:00:00.000Z",
    );

    const insertInventory = async (
      input: Readonly<{
        websiteProjectId: string;
        inventoryItemId: string;
        snapshotId: string;
        identity: string;
        sourceUrl: string;
        targetUrl: string;
        sourceDomain: string;
        providerStatus: "live" | "lost";
        lastSeenAt: string;
      }>,
    ) => {
      await client.query(
        `
        INSERT INTO backlinks.backlink_inventory_items (
          id,organization_id,workspace_id,website_project_id,
          latest_snapshot_id,source_type,provider,provider_identity,
          normalized_source_url,normalized_target_url,source_domain,
          anchor_text,provider_status,first_seen_at,last_seen_at,
          managed,created_by,updated_by
        ) VALUES (
          $4,$1,$2,$3,$5,'DATAFORSEO','dataforseo',$6,
          $7,$8,$9,'inventory view regression',$10,
          $11::timestamptz,$11::timestamptz,false,
          'migration-test','migration-test'
        )
      `,
        [
          organizationId,
          workspaceId,
          input.websiteProjectId,
          input.inventoryItemId,
          input.snapshotId,
          input.identity,
          input.sourceUrl,
          input.targetUrl,
          input.sourceDomain,
          input.providerStatus,
          input.lastSeenAt,
        ],
      );
    };
    await insertInventory({
      websiteProjectId: projectAId,
      inventoryItemId: itemIds.sharedNew,
      snapshotId: latestSnapshotAId,
      identity: "project-a-shared-new",
      sourceUrl: "https://shared.example.test/new",
      targetUrl: "https://project-a.example.test/target",
      sourceDomain: "shared.example.test",
      providerStatus: "live",
      lastSeenAt: "2026-08-07T00:00:04.000Z",
    });
    await insertInventory({
      websiteProjectId: projectAId,
      inventoryItemId: itemIds.sharedLost,
      snapshotId: latestSnapshotAId,
      identity: "project-a-shared-lost",
      sourceUrl: "https://shared.example.test/lost",
      targetUrl: "https://project-a.example.test/target",
      sourceDomain: "shared.example.test",
      providerStatus: "lost",
      lastSeenAt: "2026-08-07T00:00:03.000Z",
    });
    await insertInventory({
      websiteProjectId: projectAId,
      inventoryItemId: itemIds.oldOnly,
      snapshotId: oldSnapshotAId,
      identity: "project-a-old-only",
      sourceUrl: "https://old-only.example.test/article",
      targetUrl: "https://project-a.example.test/target",
      sourceDomain: "old-only.example.test",
      providerStatus: "live",
      lastSeenAt: "2026-08-07T00:00:02.000Z",
    });
    await insertInventory({
      websiteProjectId: projectAId,
      inventoryItemId: itemIds.currentObserved,
      snapshotId: latestSnapshotAId,
      identity: "project-a-current-observed",
      sourceUrl: "https://current.example.test/article",
      targetUrl: "https://project-a.example.test/target",
      sourceDomain: "current.example.test",
      providerStatus: "live",
      lastSeenAt: "2026-08-07T00:00:01.000Z",
    });
    await insertInventory({
      websiteProjectId: projectBId,
      inventoryItemId: itemIds.projectBNew,
      snapshotId: latestSnapshotBId,
      identity: "project-b-new",
      sourceUrl: "https://project-b-source.example.test/article",
      targetUrl: "https://project-b.example.test/target",
      sourceDomain: "project-b-source.example.test",
      providerStatus: "live",
      lastSeenAt: "2026-08-08T00:00:01.000Z",
    });

    const insertObservation = async (
      input: Readonly<{
        websiteProjectId: string;
        observationId: string;
        inventoryItemId: string;
        snapshotId: string;
        observationType: "observed" | "new" | "lost";
        providerStatus: "live" | "lost";
        pageIdentity: string;
        observedAt: string;
      }>,
    ) => {
      await client.query(
        `
        INSERT INTO backlinks.backlink_inventory_observations (
          id,organization_id,workspace_id,website_project_id,
          inventory_item_id,snapshot_id,observation_type,page_identity,
          provider_status,observed_at,evidence,created_by
        ) VALUES (
          $4,$1,$2,$3,$5,$6,$7,$8,$9,$10::timestamptz,
          '{}'::jsonb,'migration-test'
        )
      `,
        [
          organizationId,
          workspaceId,
          input.websiteProjectId,
          input.observationId,
          input.inventoryItemId,
          input.snapshotId,
          input.observationType,
          input.pageIdentity,
          input.providerStatus,
          input.observedAt,
        ],
      );
    };
    await insertObservation({
      websiteProjectId: projectAId,
      observationId: "54000000-0000-4000-8000-000000000061",
      inventoryItemId: itemIds.sharedNew,
      snapshotId: latestSnapshotAId,
      observationType: "new",
      providerStatus: "live",
      pageIdentity: "latest-a:new",
      observedAt: "2026-08-07T00:00:04.000Z",
    });
    await insertObservation({
      websiteProjectId: projectAId,
      observationId: "54000000-0000-4000-8000-000000000062",
      inventoryItemId: itemIds.sharedLost,
      snapshotId: latestSnapshotAId,
      observationType: "lost",
      providerStatus: "lost",
      pageIdentity: "latest-a:lost",
      observedAt: "2026-08-07T00:00:03.000Z",
    });
    await insertObservation({
      websiteProjectId: projectAId,
      observationId: "54000000-0000-4000-8000-000000000063",
      inventoryItemId: itemIds.oldOnly,
      snapshotId: oldSnapshotAId,
      observationType: "new",
      providerStatus: "live",
      pageIdentity: "old-a:new",
      observedAt: "2026-08-06T00:00:02.000Z",
    });
    await insertObservation({
      websiteProjectId: projectAId,
      observationId: "54000000-0000-4000-8000-000000000064",
      inventoryItemId: itemIds.currentObserved,
      snapshotId: latestSnapshotAId,
      observationType: "observed",
      providerStatus: "live",
      pageIdentity: "latest-a:observed",
      observedAt: "2026-08-07T00:00:01.000Z",
    });
    await insertObservation({
      websiteProjectId: projectBId,
      observationId: "54000000-0000-4000-8000-000000000065",
      inventoryItemId: itemIds.projectBNew,
      snapshotId: latestSnapshotBId,
      observationType: "new",
      providerStatus: "live",
      pageIdentity: "latest-b:new",
      observedAt: "2026-08-08T00:00:01.000Z",
    });

    const list = (view: "all" | "referring_domains" | "new" | "lost") =>
      store.listInventory(contextA, {
        page: 1,
        pageSize: 25,
        view,
        sort: "last_seen_desc",
      });

    await expect(list("all")).resolves.toMatchObject({
      totalCount: 4,
    });
    const referringDomains = await list("referring_domains");
    expect(referringDomains.totalCount).toBe(3);
    expect(referringDomains.items.map((item) => item.sourceDomain)).toEqual([
      "shared.example.test",
      "old-only.example.test",
      "current.example.test",
    ]);
    expect(referringDomains.items[0]?.inventoryItemId).toBe(itemIds.sharedNew);
    await expect(list("new")).resolves.toMatchObject({
      totalCount: 1,
      items: [{ inventoryItemId: itemIds.sharedNew }],
    });
    await expect(list("lost")).resolves.toMatchObject({
      totalCount: 1,
      items: [{ inventoryItemId: itemIds.sharedLost }],
    });
  });

  it("requeues an expired provider wait without duplicating its profile job", async () => {
    const organizationId = "55000000-0000-4000-8000-000000000010";
    const workspaceId = "55000000-0000-4000-8000-000000000020";
    const websiteProjectId = "55000000-0000-4000-8000-000000000030";
    const context = {
      actor: createActorContext({
        userId: "migration-test",
        sessionId: "migration-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.example.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
      }),
    };
    const idempotencyKey = "profile-provider-retry-regression";
    const unavailable = createBacklinkProfileStore(client, {
      providerEnabled: true,
      providerAvailable: false,
      estimatedCostMicros: 55_200,
      now: () => new Date("2026-08-07T00:00:00.000Z"),
    });
    const waiting = await unavailable.createSyncJob(context, {
      idempotencyKey,
      syncMode: "page",
      triggerSource: "continuation",
      requestedCursor: "cursor-v1",
    });

    expect(waiting).toMatchObject({
      status: "waiting_provider",
      providerInputRequired: true,
      replayed: false,
    });

    const beforeDue = createBacklinkProfileStore(client, {
      providerEnabled: true,
      providerAvailable: true,
      estimatedCostMicros: 55_200,
      now: () => new Date("2026-08-07T23:59:59.000Z"),
    });
    await expect(
      beforeDue.createSyncJob(context, {
        idempotencyKey,
        syncMode: "page",
        triggerSource: "continuation",
        requestedCursor: "cursor-v1",
      }),
    ).resolves.toMatchObject({
      jobId: waiting.jobId,
      status: "waiting_provider",
      replayed: true,
    });

    const afterDue = createBacklinkProfileStore(client, {
      providerEnabled: true,
      providerAvailable: true,
      estimatedCostMicros: 55_200,
      now: () => new Date("2026-08-08T00:00:01.000Z"),
    });
    const resumed = await afterDue.createSyncJob(context, {
      idempotencyKey,
      syncMode: "page",
      triggerSource: "continuation",
      requestedCursor: "cursor-v1",
    });
    const replay = await afterDue.createSyncJob(context, {
      idempotencyKey,
      syncMode: "page",
      triggerSource: "continuation",
      requestedCursor: "cursor-v1",
    });

    expect(resumed).toMatchObject({
      jobId: waiting.jobId,
      status: "queued",
      providerInputRequired: false,
      replayed: false,
    });
    expect(replay).toMatchObject({
      jobId: waiting.jobId,
      status: "queued",
      replayed: true,
    });
    expect(
      (
        await client.query(
          `
      SELECT profile.status,profile.next_sync_at AS "nextSyncAt",
             profile.version,job.status AS "jobStatus",
             job.step,job.retry_count AS "retryCount"
        FROM backlinks.backlink_profile_sync_jobs profile
        JOIN backlinks.backlink_jobs job
          ON job.organization_id=profile.organization_id
         AND job.workspace_id=profile.workspace_id
         AND job.website_project_id=profile.website_project_id
         AND job.id=profile.backlink_job_id
       WHERE profile.organization_id=$1 AND profile.workspace_id=$2
         AND profile.website_project_id=$3
         AND profile.idempotency_key=$4
    `,
          [organizationId, workspaceId, websiteProjectId, idempotencyKey],
        )
      ).rows,
    ).toEqual([
      {
        status: "queued",
        nextSyncAt: null,
        version: 2,
        jobStatus: "queued",
        step: "scheduled",
        retryCount: 1,
      },
    ]);
  });

  it("persists an idempotent immediate check request as the writer role", async () => {
    const organizationId = "54000000-0000-4000-8000-000000000010";
    const workspaceId = "54000000-0000-4000-8000-000000000020";
    const websiteProjectId = "54000000-0000-4000-8000-000000000030";
    const inventoryItemId = "54000000-0000-4000-8000-000000000040";
    const context = {
      actor: createActorContext({
        userId: "migration-test",
        sessionId: "migration-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.example.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
      }),
    };

    await client.query(
      `
      INSERT INTO backlinks.backlink_inventory_items (
        id, organization_id, workspace_id, website_project_id,
        source_type, provider, provider_identity,
        normalized_source_url, normalized_target_url, source_domain,
        provider_status, managed, created_by, updated_by
      ) VALUES (
        $4, $1, $2, $3,
        'USER_IMPORTED', 'user_import', 'immediate-check-regression',
        'https://check.example.test/post',
        'https://owner.example.test/target',
        'check.example.test', 'unknown', true,
        'migration-test', 'migration-test'
      );
    `,
      [organizationId, workspaceId, websiteProjectId, inventoryItemId],
    );

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query("SET LOCAL search_path = backlinks, pg_catalog");
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.current_workspace_id', $2, true),
                set_config('app.current_website_project_id', $3, true),
                set_config('app.current_project_id', $3, true)`,
        [organizationId, workspaceId, websiteProjectId],
      );
      const store = createBacklinkProfileStore(client, {
        providerEnabled: false,
        providerAvailable: false,
        estimatedCostMicros: 0,
      });
      const started: unknown[] = [];
      const service = createBacklinkProfileService({
        queryStore: store,
        commandStore: async () => {
          throw new Error("Profile sync is not part of this test.");
        },
        scheduler: {
          async start() {
            throw new Error("Profile sync is not part of this test.");
          },
        },
        inventoryScheduler: {
          async start(input) {
            started.push(input);
          },
        },
      });
      const first = await service.requestInventoryCheck(
        context,
        inventoryItemId,
        { idempotencyKey: "immediate-check-regression" },
      );
      const replay = await service.requestInventoryCheck(
        context,
        inventoryItemId,
        { idempotencyKey: "immediate-check-regression" },
      );

      expect(first).toMatchObject({
        inventoryItemId,
        replayed: false,
      });
      expect(replay).toMatchObject({
        inventoryItemId,
        runId: first.runId,
        observationId: first.observationId,
        replayed: true,
      });
      expect(started).toEqual([first.monitorInput]);
      expect(
        (
          await client.query(
            `
        SELECT count(*)::integer count
          FROM backlink_inventory_monitor_requests
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND inventory_item_id=$4
      `,
            [organizationId, workspaceId, websiteProjectId, inventoryItemId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
});
