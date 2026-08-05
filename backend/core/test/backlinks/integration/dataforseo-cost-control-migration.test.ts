import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DataForSeoRequestService,
  type DataForSeoRequestStart,
} from "../../../src/modules/backlinks/application/services/dataforseo-request.service.js";
import {
  ProviderBulkRequestService,
} from "../../../src/modules/backlinks/application/services/provider-bulk-request.service.js";
import {
  createProviderArtifactFreshnessWindow,
} from "../../../src/modules/backlinks/application/policies/provider-freshness.policy.js";
import {
  DataForSeoCallPolicy,
} from "../../../src/modules/backlinks/application/policies/dataforseo-call.policy.js";
import {
  createProviderAnalysisRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-analysis.repository.js";
import {
  createProviderArtifactRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-artifact.repository.js";
import {
  createProviderBulkArtifactRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-bulk-artifact.repository.js";
import {
  createProviderBudgetRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-budget.repository.js";
import {
  createProviderCostBaselineRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-cost-baseline.repository.js";
import {
  createProviderFetchLeaseRepository,
} from "../../../src/modules/backlinks/db/repositories/provider-fetch-lease.repository.js";
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
type PgError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migration = (name: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${name}`,
  import.meta.url,
);
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1);
const workspaceA = id(2);
const projectA = id(3);
const workspaceB = id(4);
const projectB = id(5);
const expectPermissionDenied = async (query: Promise<unknown>) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code: "42501" });
};
const configureOwner = async (client: Client) => {
  await client.query("SET ROLE growthos_backlinks_owner");
  await client.query("SET search_path = backlinks, pg_catalog");
};

describe("DFS-COST-003/004 PostgreSQL cost control", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    await client.query(await readFile(
      migration("0005_backlink_schema_role_ownership.sql"),
      "utf8",
    ));
    await client.query(await readFile(
      migration("0032_dataforseo_cost_control.sql"),
      "utf8",
    ));
    await client.query(await readFile(
      migration("0037_dataforseo_worker_execution.sql"),
      "utf8",
    ));
    await client.query("SET search_path = backlinks, pg_catalog");
  }, 120_000);

  beforeEach(async () => {
    await client.query("RESET ROLE");
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      TRUNCATE provider_artifact_usages,workspace_evidence_projections,
        provider_artifacts,provider_fetch_leases,provider_batch_requests,
        backlink_provider_usage_ledger,backlink_provider_cache_entries,
        backlink_seo_snapshots,backlink_provider_requests,
        backlink_provider_budgets CASCADE
    `);
  });

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("separates public Artifacts from tenant Projections and direct roles", async () => {
    const tables = (await client.query(`
      SELECT c.relname,
        c.relrowsecurity AND c.relforcerowsecurity AS secure,
        owner.rolname AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_roles owner ON owner.oid=c.relowner
      WHERE n.nspname='backlinks' AND c.relname IN (
        'provider_batch_requests',
        'provider_artifacts',
        'workspace_evidence_projections',
        'provider_artifact_usages',
        'provider_fetch_leases'
      )
      ORDER BY c.relname
    `)).rows;
    expect(tables).toHaveLength(5);
    expect(tables.every(({ secure, owner }) =>
      secure === true && owner === "growthos_backlinks_owner")).toBe(true);

    const artifactColumns = (await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='backlinks' AND table_name='provider_artifacts'
    `)).rows.map(({ column_name: column }) => column);
    expect(artifactColumns).not.toEqual(expect.arrayContaining([
      "organization_id",
      "workspace_id",
      "website_project_id",
    ]));

    const privileges = (await client.query(`
      SELECT
        has_table_privilege(
          'growthos_backlinks_writer',
          'backlinks.provider_artifacts',
          'SELECT'
        ) AS artifact_read,
        has_table_privilege(
          'growthos_backlinks_writer',
          'backlinks.provider_batch_requests',
          'SELECT,INSERT,UPDATE'
        ) AS batch_write,
        has_table_privilege(
          'growthos_backlinks_writer',
          'backlinks.provider_fetch_leases',
          'SELECT,INSERT,UPDATE'
        ) AS lease_write,
        has_table_privilege(
          'growthos_backlinks_writer',
          'backlinks.workspace_evidence_projections',
          'SELECT,INSERT,UPDATE,DELETE'
        ) AS projection_crud
    `)).rows[0];
    expect(privileges).toEqual({
      artifact_read: true,
      batch_write: true,
      lease_write: true,
      projection_crud: true,
    });
  });

  it("projects one public Artifact into isolated Workspace views", async () => {
    const fingerprint = "a".repeat(64);
    await client.query(`
      INSERT INTO provider_batch_requests (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        request_intent,refresh_mode,location_code,language_code,
        request_schema_version,response_schema_version,
        normalized_request_hash,request_count,succeeded_count,
        estimated_cost_micros,actual_cost_micros,status,started_at,finished_at,
        request_id,budget_reservation_id,created_by
      ) VALUES (
        '${id(101)}','${organization}','${workspaceA}','${projectA}',
        'dataforseo','endpoint','DISCOVERY','BACKGROUND_REFRESH','US','en-US',
        1,'response.v1','${"9".repeat(64)}',1,1,10,10,'succeeded',
        '2026-07-30T08:00:00Z','2026-07-30T08:00:01Z',
        'request-101','budget-101','test'
      );
      INSERT INTO provider_artifacts (
        id,artifact_fingerprint,provider,endpoint,subject_type,subject_key,
        location_code,language_code,request_schema_version,
        response_schema_version,normalized_payload,payload_hash,
        quality_status,observed_at,fresh_until,stale_until,source_batch_id
      ) VALUES (
        '${id(102)}','${fingerprint}','dataforseo','endpoint','domain',
        'example.com','US','en-US',1,'response.v1',
        '{"provider":"dataforseo","schemaVersion":"response.v1",
          "requestedAt":"2026-07-30T08:00:00.000Z",
          "completedAt":"2026-07-30T08:00:01.000Z","costMicros":10,
          "payloadHash":"${"a".repeat(64)}","referringDomains":[]}',
        '${"a".repeat(64)}','negative','2026-07-30T08:00:01Z',
        '2026-07-30T14:00:01Z','2026-07-31T08:00:01Z','${id(101)}'
      );
      INSERT INTO workspace_evidence_projections (
        id,organization_id,workspace_id,website_project_id,artifact_id,
        project_context_version,usage_purpose,first_served_at,last_served_at
      ) VALUES
        (
          '${id(103)}','${organization}','${workspaceA}','${projectA}',
          '${id(102)}',1,'discovery','2026-07-30T08:00:01Z',
          '2026-07-30T08:00:01Z'
        ),
        (
          '${id(104)}','${organization}','${workspaceB}','${projectB}',
          '${id(102)}',1,'discovery','2026-07-30T08:00:01Z',
          '2026-07-30T08:00:01Z'
        );
    `);

    await client.query("SET ROLE growthos_backlinks_writer");
    await client.query(`
      SELECT set_config('app.current_organization_id','${organization}',false),
        set_config('app.current_workspace_id','${workspaceA}',false),
        set_config('app.current_website_project_id','${projectA}',false)
    `);
    expect((await client.query(`
      SELECT id FROM workspace_evidence_projections
    `)).rows).toEqual([{ id: id(103) }]);
    expect((await client.query(
      "SELECT artifact_fingerprint FROM provider_artifacts",
    )).rows).toEqual([{ artifact_fingerprint: fingerprint }]);
    expect((await client.query(
      "SELECT id FROM provider_batch_requests",
    )).rows).toEqual([{ id: id(101) }]);
    await client.query("RESET ROLE");
    await client.query("RESET app.current_organization_id");
    await client.query("RESET app.current_workspace_id");
    await client.query("RESET app.current_website_project_id");

    await configureOwner(client);
    expect((await client.query(`
      SELECT count(*)::int AS count
      FROM workspace_evidence_projections
      WHERE artifact_id='${id(102)}'
    `)).rows).toEqual([{ count: 2 }]);
    await client.query("RESET ROLE");
  });

  it("limits Worker artifact writes to a Batch owned by the current tenant", async () => {
    await configureOwner(client);
    await client.query(`
      INSERT INTO provider_batch_requests (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        request_intent,refresh_mode,location_code,language_code,
        request_schema_version,response_schema_version,
        normalized_request_hash,request_count,estimated_cost_micros,status,
        started_at,request_id,budget_reservation_id,created_by
      ) VALUES (
        '${id(111)}','${organization}','${workspaceB}','${projectB}',
        'dataforseo','endpoint','DISCOVERY','BACKGROUND_REFRESH','ZA','en',
        1,'response.v1','${"8".repeat(64)}',1,10,'running',
        '2026-08-04T08:00:00Z','request-111','budget-111','test'
      )
    `);
    await client.query("RESET ROLE");
    await client.query("SET ROLE growthos_backlinks_writer");
    await client.query(`
      SELECT set_config('app.current_organization_id','${organization}',false),
        set_config('app.current_workspace_id','${workspaceA}',false),
        set_config('app.current_website_project_id','${projectA}',false)
    `);
    await client.query(`
      INSERT INTO provider_batch_requests (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        request_intent,refresh_mode,location_code,language_code,
        request_schema_version,response_schema_version,
        normalized_request_hash,request_count,estimated_cost_micros,status,
        started_at,request_id,budget_reservation_id,created_by
      ) VALUES (
        '${id(112)}','${organization}','${workspaceA}','${projectA}',
        'dataforseo','endpoint','DISCOVERY','BACKGROUND_REFRESH','ZA','en',
        1,'response.v1','${"7".repeat(64)}',1,10,'running',
        '2026-08-04T08:00:00Z','request-112','budget-112','worker'
      )
    `);
    expect((await client.query(
      "SELECT id FROM provider_batch_requests ORDER BY id",
    )).rows).toEqual([{ id: id(112) }]);
    await client.query(`
      INSERT INTO provider_fetch_leases (
        artifact_fingerprint,status,owner_request_id,lease_expires_at,
        heartbeat_at
      ) VALUES (
        '${"6".repeat(64)}','acquired','request-112',
        '2026-08-04T08:01:00Z','2026-08-04T08:00:00Z'
      )
    `);
    await client.query(`
      INSERT INTO provider_artifacts (
        id,artifact_fingerprint,provider,endpoint,subject_type,subject_key,
        location_code,language_code,request_schema_version,
        response_schema_version,normalized_payload,payload_hash,
        quality_status,observed_at,fresh_until,stale_until,source_batch_id
      ) VALUES (
        '${id(113)}','${"5".repeat(64)}','dataforseo','endpoint','domain',
        'real-domain.test','ZA','en',1,'response.v1',
        '{"provider":"dataforseo","schemaVersion":"response.v1",
          "requestedAt":"2026-08-04T08:00:00.000Z",
          "completedAt":"2026-08-04T08:00:01.000Z","costMicros":10,
          "payloadHash":"${"5".repeat(64)}","referringDomains":[]}',
        '${"5".repeat(64)}','negative','2026-08-04T08:00:01Z',
        '2026-08-04T14:00:01Z','2026-08-05T08:00:01Z','${id(112)}'
      )
    `);
    await expectPermissionDenied(client.query(`
      INSERT INTO provider_artifacts (
        id,artifact_fingerprint,provider,endpoint,subject_type,subject_key,
        location_code,language_code,request_schema_version,
        response_schema_version,normalized_payload,payload_hash,
        quality_status,observed_at,fresh_until,stale_until,source_batch_id
      ) VALUES (
        '${id(114)}','${"4".repeat(64)}','dataforseo','endpoint','domain',
        'other-tenant.test','ZA','en',1,'response.v1',
        '{"provider":"dataforseo","schemaVersion":"response.v1",
          "requestedAt":"2026-08-04T08:00:00.000Z",
          "completedAt":"2026-08-04T08:00:01.000Z","costMicros":10,
          "payloadHash":"${"4".repeat(64)}","referringDomains":[]}',
        '${"4".repeat(64)}','negative','2026-08-04T08:00:01Z',
        '2026-08-04T14:00:01Z','2026-08-05T08:00:01Z','${id(111)}'
      )
    `));
  });

  it("uses one global lease and one Provider call across service instances", async () => {
    await configureOwner(client);
    await insertBudget(client, workspaceA, id(190));
    await insertBudget(client, workspaceB, id(191));
    await client.query("RESET ROLE");
    const clients = [
      new PgClient({ connectionString: harness.connectionString }),
      new PgClient({ connectionString: harness.connectionString }),
    ];
    await Promise.all(clients.map(async (opened) => {
      await opened.connect();
      await configureOwner(opened);
    }));
    let release!: () => void;
    const providerWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchBacklinkSnapshot = vi.fn(async () => {
      await providerWait;
      const requestedAt = new Date().toISOString();
      return {
        provider: "dataforseo" as const,
        schemaVersion: "dataforseo.backlinks-referring-domains.v1",
        requestedAt,
        completedAt: new Date().toISOString(),
        costMicros: 20,
        payloadHash: "b".repeat(64),
        referringDomains: [],
      };
    });
    const service = (index: number) => {
      const opened = clients[index];
      if (opened === undefined) {
        throw new Error("Missing PostgreSQL test client");
      }
      const repository = createProviderAnalysisRepository(
        opened,
        () => new Date(),
      );
      return new DataForSeoRequestService({
        coordinator: repository,
        provider: { fetchBacklinkSnapshot },
        gate: new DataForSeoCallPolicy({
          checkKillSwitch: async () => "allow",
          checkQuota: async () => "allow",
          reserveBudget: repository.reserveBudget,
        }),
        heartbeatIntervalMs: 50,
        now: () => new Date(),
      });
    };
    const input = (
      requestId: string,
      workspaceId: string,
      websiteProjectId: string,
    ) => ({
      context: {
        organizationId: organization,
        workspaceId,
        websiteProjectId,
        requestId,
        idempotencyKey: requestId,
        budgetReservationId: requestId,
      },
      request: {
        target: "single-flight.example",
        targetType: "domain" as const,
        limit: 100,
      },
      intent: "DISCOVERY" as const,
      refreshMode: "BACKGROUND_REFRESH" as const,
      execution: "BACKGROUND" as const,
      locationCode: "US",
      languageCode: "en-US",
      responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
      usagePurpose: "single-flight-proof",
      projectContextVersion: 1,
      cacheSchemaVersion: 1,
      estimatedCostMicros: 20,
    });

    try {
      const first = service(0).execute(input(id(201), workspaceA, projectA));
      const second = service(1).execute(input(id(202), workspaceB, projectB));
      await vi.waitFor(() =>
        expect(fetchBacklinkSnapshot).toHaveBeenCalledTimes(1));
      release();
      const results = await Promise.all([first, second]);

      expect(results.map(({ source }) => source).sort()).toEqual([
        "provider",
        "single-flight",
      ]);
      expect(fetchBacklinkSnapshot).toHaveBeenCalledOnce();
      expect((await client.query(`
        SELECT count(*)::int AS count FROM provider_artifacts
        WHERE subject_key='single-flight.example'
      `)).rows).toEqual([{ count: 1 }]);
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM provider_artifact_usages u
        JOIN provider_artifacts a ON a.id=u.artifact_id
        WHERE a.subject_key='single-flight.example'
      `)).rows).toEqual([{ count: 2 }]);
    } finally {
      await Promise.all(clients.map((opened) => opened.end()));
    }
  }, 30_000);

  it("persists partial Bulk results for later single-domain reuse", async () => {
    await configureOwner(client);
    const completedAt = new Date("2026-07-30T10:00:01.000Z");
    await insertBudget(client, workspaceA, id(290));
    const successSnapshot = {
      provider: "dataforseo" as const,
      schemaVersion: "dataforseo.backlinks-referring-domains.v1",
      requestedAt: "2026-07-30T10:00:00.000Z",
      completedAt: completedAt.toISOString(),
      costMicros: 4,
      payloadHash: "1".repeat(64),
      referringDomains: [],
    };
    const emptySnapshot = {
      ...successSnapshot,
      costMicros: 4,
      payloadHash: "2".repeat(64),
    };
    const fetchBatch = vi.fn(async () => ({
      actualCostMicros: 11,
      rawPayloadHash: "3".repeat(64),
      providerTaskId: "provider-task-1",
      results: [
        {
          itemKey: "success",
          status: "success" as const,
          snapshot: successSnapshot,
        },
        {
          itemKey: "empty",
          status: "empty" as const,
          snapshot: emptySnapshot,
        },
        {
          itemKey: "failed",
          status: "permanent_error" as const,
          code: "INVALID_TARGET",
        },
      ],
    }));
    const service = new ProviderBulkRequestService({
      provider: { fetchBatch },
      gate: new DataForSeoCallPolicy({
        checkKillSwitch: async () => "allow",
        checkQuota: async () => "allow",
        reserveBudget: createProviderBudgetRepository(
          client,
          () => completedAt,
        ).reserveBudget,
      }),
      store: createProviderBulkArtifactRepository(client),
      now: () => completedAt,
    });
    const bulkResult = await service.execute({
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: "bulk-business-request",
        idempotencyKey: "bulk-business-request",
        budgetReservationId: "bulk-budget-reservation",
      },
      intent: "CARD_ENRICHMENT",
      refreshMode: "BACKGROUND_REFRESH",
      endpoint: "/v3/backlinks/referring_domains/live",
      locationCode: "US",
      languageCode: "en-US",
      requestSchemaVersion: 1,
      responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
      usagePurpose: "recommendation-card-enrichment",
      projectContextVersion: 1,
      estimatedCostMicros: 12,
      items: [
        {
          itemKey: "success",
          request: {
            target: "bulk-success.example",
            targetType: "domain",
            limit: 100,
          },
        },
        {
          itemKey: "empty",
          request: {
            target: "bulk-empty.example",
            targetType: "domain",
            limit: 100,
          },
        },
        {
          itemKey: "failed",
          request: {
            target: "bulk-failed.example",
            targetType: "domain",
            limit: 100,
          },
        },
      ],
    });

    expect(fetchBatch).toHaveBeenCalledOnce();
    expect(bulkResult.results.map(({ allocatedCostMicros }) =>
      allocatedCostMicros).reduce((total, cost) => total + cost, 0)).toBe(11);
    expect((await client.query(`
      SELECT request_count AS "requestCount",
        succeeded_count AS "succeededCount",
        negative_count AS "negativeCount",
        failed_count AS "failedCount",
        actual_cost_micros AS "actualCostMicros",status,request_id AS "requestId",
        budget_reservation_id AS "budgetReservationId",
        jsonb_array_length(result_summary) AS "resultCount"
      FROM provider_batch_requests
      WHERE request_id='bulk-business-request'
    `)).rows).toEqual([{
      requestCount: 3,
      succeededCount: 1,
      negativeCount: 1,
      failedCount: 1,
      actualCostMicros: "11",
      status: "partial",
      requestId: "bulk-business-request",
      budgetReservationId: "bulk-budget-reservation",
      resultCount: 3,
    }]);
    expect((await client.query(`
      SELECT ledger.status,ledger.actual_cost_micros AS "actualCostMicros",
        budget.spent_micros AS "spentMicros",
        budget.reserved_micros AS "reservedMicros"
      FROM backlink_provider_usage_ledger ledger
      JOIN backlink_provider_budgets budget ON budget.id=ledger.budget_id
    `)).rows).toEqual([{
      status: "settled",
      actualCostMicros: "11",
      spentMicros: "11",
      reservedMicros: "0",
    }]);
    expect((await client.query(`
      SELECT subject_key AS "subjectKey",quality_status AS "qualityStatus"
      FROM provider_artifacts
      WHERE subject_key LIKE 'bulk-%'
      ORDER BY subject_key
    `)).rows).toEqual([
      { subjectKey: "bulk-empty.example", qualityStatus: "negative" },
      { subjectKey: "bulk-success.example", qualityStatus: "complete" },
    ]);

    const fetchSingle = vi.fn(async () => successSnapshot);
    const singleRepository = createProviderAnalysisRepository(
      client,
      () => new Date("2026-07-30T10:01:00.000Z"),
    );
    const single = new DataForSeoRequestService({
      coordinator: singleRepository,
      provider: { fetchBacklinkSnapshot: fetchSingle },
      gate: { authorize: async () => undefined },
      now: () => new Date("2026-07-30T10:01:00.000Z"),
    });
    await expect(single.execute({
      context: {
        organizationId: organization,
        workspaceId: workspaceB,
        websiteProjectId: projectB,
        requestId: "single-after-bulk",
        idempotencyKey: "single-after-bulk",
        budgetReservationId: "single-after-bulk",
      },
      request: {
        target: "bulk-success.example",
        targetType: "domain",
        limit: 100,
      },
      intent: "CARD_ENRICHMENT",
      refreshMode: "CACHE_PREFERRED",
      execution: "BACKGROUND",
      locationCode: "US",
      languageCode: "en-US",
      responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
      usagePurpose: "single-domain-reuse",
      projectContextVersion: 1,
      cacheSchemaVersion: 1,
      estimatedCostMicros: 4,
    })).resolves.toMatchObject({ source: "cache" });
    expect(fetchSingle).not.toHaveBeenCalled();
    const reusableArtifactId = String((await client.query(`
      SELECT id FROM provider_artifacts
      WHERE subject_key='bulk-success.example'
    `)).rows[0]?.id);
    await client.query("RESET ROLE");
    await client.query("SET ROLE growthos_backlinks_writer");
    for (const [workspaceId, websiteProjectId] of [
      [workspaceA, projectA],
      [workspaceB, projectB],
    ]) {
      await client.query(`
        SELECT
          set_config('app.current_organization_id',$1,false),
          set_config('app.current_workspace_id',$2,false),
          set_config('app.current_website_project_id',$3,false)
      `, [organization, workspaceId, websiteProjectId]);
      expect((await client.query(`
        SELECT count(*)::int AS count
        FROM workspace_evidence_projections p
        WHERE p.artifact_id=$1::uuid
      `, [reusableArtifactId])).rows).toEqual([{ count: 1 }]);
    }
    await client.query("RESET ROLE");
    await configureOwner(client);
    const baseline = await createProviderCostBaselineRepository(client).read({
      organizationId: organization,
      workspaceId: workspaceA,
      websiteProjectId: projectA,
      from: new Date("2026-07-30T10:00:00.000Z"),
      to: new Date("2026-07-30T10:02:00.000Z"),
      maxBatchSize: 100,
      businessOutcomes: {
        readyProspectCount: 2,
        opportunityCount: 1,
        acquiredLinkCount: 0,
        totalEnrichmentCount: 3,
        unusedEnrichmentCount: 1,
        readyInventoryWaitP95Ms: 450,
      },
    });
    expect(baseline).toMatchObject({
      providerRequestsTotal: 1,
      providerRequestItemsTotal: 3,
      providerSpendMicros: 11,
      providerEstimateErrorRatio: 1 / 12,
      providerCacheHitRate: 0,
      providerHitRate: 1,
      providerBulkFillRatio: 0.03,
      providerPartialFailureRate: 1,
      providerCostPerReadyProspectMicros: 6,
      providerCostPerOpportunityMicros: 11,
      providerCostPerAcquiredLinkMicros: null,
      crossWorkspaceArtifactReuseRate: 0.5,
      unusedEnrichmentRatio: 1 / 3,
      unknownChargeCount: 0,
      readyInventoryWaitP95Ms: 450,
    });
    expect(baseline.requestsByEndpointIntentStatus).toEqual([{
      endpoint: "/v3/backlinks/referring_domains/live",
      requestIntent: "CARD_ENRICHMENT",
      status: "partial",
      providerBatchRequests: 1,
      providerRequestItems: 3,
    }]);
    expect(baseline.averageCostByUsagePurpose).toEqual([{
      usagePurpose: "recommendation-card-enrichment",
      usageCount: 2,
      allocatedCostMicros: 7,
      averageCostMicros: 4,
    }]);
    await client.query("RESET ROLE");
    await client.query("RESET app.current_organization_id");
    await client.query("RESET app.current_workspace_id");
    await client.query("RESET app.current_website_project_id");
  });

  it("rolls back Batch and Artifact when Projection/Usage cannot commit", async () => {
    await configureOwner(client);
    const artifacts = createProviderArtifactRepository(client);
    const leases = createProviderFetchLeaseRepository(client);
    const startedAt = new Date("2026-07-30T09:00:00.000Z");
    const completedAt = new Date("2026-07-30T09:00:01.000Z");
    const fingerprint = "e".repeat(64);
    const start: DataForSeoRequestStart = {
      key: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        provider: "dataforseo",
        endpoint: "/v3/backlinks/referring_domains/live",
        requestFingerprint: fingerprint,
        requestSchemaVersion: 1,
        cacheSchemaVersion: 1,
      },
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: "business-request-not-a-uuid",
        idempotencyKey: "atomic-rollback",
        budgetReservationId: "atomic-rollback",
      },
      request: {
        target: "atomic-rollback.example",
        targetType: "domain",
        limit: 100,
      },
      intent: "DISCOVERY",
      refreshMode: "BACKGROUND_REFRESH",
      locationCode: "US",
      languageCode: "en-US",
      responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
      usagePurpose: "atomic-rollback-proof",
      projectContextVersion: 0,
      estimatedCostMicros: 20,
      now: startedAt,
      freshUntil: new Date("2026-08-06T09:00:00.000Z"),
      staleUntil: new Date("2026-08-29T09:00:00.000Z"),
    };
    const batchRequestId = await artifacts.startBatch(start);
    await leases.acquire({
      artifactFingerprint: fingerprint,
      ownerRequestId: start.context.requestId,
      acquiredAt: startedAt,
      leaseExpiresAt: new Date("2026-07-30T09:01:00.000Z"),
    });
    const providerSnapshot = {
      provider: "dataforseo" as const,
      schemaVersion: "dataforseo.backlinks-referring-domains.v1",
      requestedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      costMicros: 20,
      payloadHash: "f".repeat(64),
      referringDomains: [],
    };

    await expect(artifacts.complete({
      start,
      batchRequestId,
      snapshot: providerSnapshot,
      freshness: createProviderArtifactFreshnessWindow({
        intent: start.intent,
        observedAt: completedAt,
        negative: true,
      }),
      completedAt,
    })).rejects.toMatchObject({ code: "23514" });

    expect((await client.query(`
      SELECT status,actual_cost_micros AS "actualCostMicros"
      FROM provider_batch_requests WHERE id=$1
    `, [batchRequestId])).rows).toEqual([{
      status: "running",
      actualCostMicros: null,
    }]);
    expect((await client.query(`
      SELECT count(*)::int AS count FROM provider_artifacts
      WHERE artifact_fingerprint=$1
    `, [fingerprint])).rows).toEqual([{ count: 0 }]);
    expect(await leases.read(fingerprint)).toMatchObject({
      status: "acquired",
      ownerRequestId: start.context.requestId,
    });
    await client.query("RESET ROLE");
  });

  it("blocks retries after unknown charge and permits expired takeover", async () => {
    await configureOwner(client);
    const leases = createProviderFetchLeaseRepository(client);
    const acquiredAt = new Date("2026-07-30T08:00:00.000Z");
    const unknownFingerprint = "c".repeat(64);
    expect(await leases.acquire({
      artifactFingerprint: unknownFingerprint,
      ownerRequestId: "unknown-owner",
      acquiredAt,
      leaseExpiresAt: new Date("2026-07-30T08:01:00.000Z"),
    })).toMatchObject({ acquired: true });
    await leases.fail({
      artifactFingerprint: unknownFingerprint,
      ownerRequestId: "unknown-owner",
      status: "unknown_charge",
      failureCode: "DATAFORSEO_RESULT_UNKNOWN",
      failedAt: new Date("2026-07-30T08:00:10.000Z"),
    });
    expect(await leases.acquire({
      artifactFingerprint: unknownFingerprint,
      ownerRequestId: "retry-owner",
      acquiredAt: new Date("2026-07-30T08:02:00.000Z"),
      leaseExpiresAt: new Date("2026-07-30T08:03:00.000Z"),
    })).toMatchObject({ acquired: false, status: "unknown_charge" });

    const expiredFingerprint = "d".repeat(64);
    await leases.acquire({
      artifactFingerprint: expiredFingerprint,
      ownerRequestId: "stale-owner",
      acquiredAt,
      leaseExpiresAt: new Date("2026-07-30T08:01:00.000Z"),
    });
    expect(await leases.acquire({
      artifactFingerprint: expiredFingerprint,
      ownerRequestId: "takeover-owner",
      acquiredAt: new Date("2026-07-30T08:02:00.000Z"),
      leaseExpiresAt: new Date("2026-07-30T08:03:00.000Z"),
    })).toMatchObject({
      acquired: true,
      ownerRequestId: "takeover-owner",
    });
    await client.query("RESET ROLE");
  });
});

async function insertBudget(
  client: Client,
  workspaceId: string,
  budgetId: string,
): Promise<void> {
  await client.query(`
    INSERT INTO backlink_provider_budgets (
      id,organization_id,workspace_id,provider,period_start,period_end,
      limit_micros,created_by
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'dataforseo',
      '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',1000000,'test'
    )
  `, [budgetId, organization, workspaceId]);
}
