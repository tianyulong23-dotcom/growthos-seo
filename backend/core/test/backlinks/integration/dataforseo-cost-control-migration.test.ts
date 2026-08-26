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
  ensureProviderBudgetCycle,
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

  it("serializes concurrent reservations at the paid-call ceiling", async () => {
    const observedAt = new Date("2026-08-12T08:00:00.000Z");
    const budgetId = id(390);
    const requestIds = Array.from({ length: 5 }, (_, index) => id(391 + index));
    await insertBudget(client, workspaceA, budgetId);
    for (const [index, requestId] of requestIds.entries()) {
      const requestFingerprint = String(index + 1).repeat(64);
      const reservationKey = `paid-call-ceiling-${index}`;
      await client.query(`
        INSERT INTO provider_batch_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_intent,refresh_mode,location_code,language_code,
          request_schema_version,response_schema_version,
          normalized_request_hash,request_count,estimated_cost_micros,status,
          started_at,request_id,budget_reservation_id,created_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
          'DISCOVERY','BACKGROUND_REFRESH','US','en-US',1,'response.v1',
          $5,1,10,'running',$6,$7,$8,'test'
        )
      `, [
        requestId,
        organization,
        workspaceA,
        projectA,
        requestFingerprint,
        observedAt,
        `paid-call-request-${index}`,
        reservationKey,
      ]);
      await createProviderBudgetRepository(client, () => observedAt)
        .recordRequest({
          batchRequestId: requestId,
          context: {
            organizationId: organization,
            workspaceId: workspaceA,
            websiteProjectId: projectA,
            requestId: `paid-call-request-${index}`,
            idempotencyKey: reservationKey,
            budgetReservationId: reservationKey,
          },
          endpoint: "endpoint",
          requestFingerprint,
          requestSchemaVersion: 1,
          requestPayload: { index },
          startedAt: observedAt,
        });
    }

    const clients = requestIds.map(
      () => new PgClient({ connectionString: harness.connectionString }),
    );
    await Promise.all(clients.map(async (opened) => {
      await opened.connect();
      await configureOwner(opened);
    }));
    const reservationInput = (index: number) => ({
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: `paid-call-request-${index}`,
        idempotencyKey: `paid-call-ceiling-${index}`,
        budgetReservationId: `paid-call-ceiling-${index}`,
      },
      provider: "dataforseo" as const,
      requestFingerprint: String(index + 1).repeat(64),
      reservationKey: `paid-call-ceiling-${index}`,
      estimatedCostMicros: 10,
    });
    try {
      const decisions = await Promise.all(clients.map(async (opened, index) => {
        await opened.query("BEGIN");
        try {
          await opened.query(`
            SELECT set_config('app.current_organization_id',$1,true),
              set_config('app.current_workspace_id',$2,true),
              set_config('app.current_website_project_id',$3,true)
          `, [organization, workspaceA, projectA]);
          const decision = await createProviderBudgetRepository(
            opened,
            () => observedAt,
          ).reserveBudgetWithinPaidCallCeiling(
            reservationInput(index),
            3,
            1_000_000,
          );
          await opened.query("COMMIT");
          return decision;
        } catch (error) {
          await opened.query("ROLLBACK");
          throw error;
        }
      }));
      expect(decisions.filter((decision) => decision === "allow")).toHaveLength(3);
      expect(decisions.filter((decision) => decision === "deny")).toHaveLength(2);

      const allowedIndex = decisions.findIndex(
        (decision) => decision === "allow",
      );
      const retryClient = clients[allowedIndex];
      if (retryClient === undefined) {
        throw new Error("Missing allowed reservation client");
      }
      await retryClient.query("BEGIN");
      await retryClient.query(`
        SELECT set_config('app.current_organization_id',$1,true),
          set_config('app.current_workspace_id',$2,true),
          set_config('app.current_website_project_id',$3,true)
      `, [organization, workspaceA, projectA]);
      const retryDecision = await createProviderBudgetRepository(
        retryClient,
        () => observedAt,
      ).reserveBudgetWithinPaidCallCeiling(
        reservationInput(allowedIndex),
        3,
        1_000_000,
      );
      await retryClient.query("COMMIT");
      expect(retryDecision).toBe("allow");
      expect((await client.query(`
        SELECT count(*)::integer count
          FROM backlink_provider_usage_ledger
         WHERE budget_id=$1::uuid AND status='reserved'
      `, [budgetId])).rows).toEqual([{ count: 3 }]);
      expect((await client.query(`
        SELECT reserved_micros AS "reservedMicros"
          FROM backlink_provider_budgets
         WHERE id=$1::uuid
      `, [budgetId])).rows).toEqual([{ reservedMicros: "30" }]);
    } finally {
      await Promise.all(clients.map((opened) => opened.end()));
    }
  }, 30_000);

  it("raises an active budget to the automatic overage limit without lowering it", async () => {
    const observedAt = new Date("2026-08-12T08:00:00.000Z");
    const budgetId = id(405);
    await insertBudget(client, workspaceA, budgetId);

    await ensureProviderBudgetCycle(client, {
      organizationId: organization,
      workspaceId: workspaceA,
      provider: "dataforseo",
      limitMicros: 2_000_000,
      createdBy: "automatic-overage-test",
      observedAt,
    });
    await ensureProviderBudgetCycle(client, {
      organizationId: organization,
      workspaceId: workspaceA,
      provider: "dataforseo",
      limitMicros: 1_000_000,
      createdBy: "automatic-overage-test",
      observedAt,
    });

    expect((await client.query(`
      SELECT limit_micros AS "limitMicros"
        FROM backlink_provider_budgets
       WHERE id=$1::uuid
    `, [budgetId])).rows).toEqual([{ limitMicros: "2000000" }]);
  });

  it("shares one concurrent ceiling across discovery, qualification, and windows", async () => {
    const observedAt = new Date("2026-08-12T09:00:00.000Z");
    const budgetId = id(410);
    const historicalPrefix = `commercial-qualification-v4:${id(411)}`;
    const operationPrefix = `commercial-refill-operation:${id(412)}`;
    const historicalIds = Array.from(
      { length: 3 },
      (_, index) => id(413 + index),
    );
    const operationIds = Array.from(
      { length: 5 },
      (_, index) => id(416 + index),
    );
    await insertBudget(client, workspaceA, budgetId);

    const insertRequest = async (
      requestId: string,
      reservationKey: string,
      requestFingerprint: string,
    ) => {
      await client.query(`
        INSERT INTO provider_batch_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_intent,refresh_mode,location_code,language_code,
          request_schema_version,response_schema_version,
          normalized_request_hash,request_count,estimated_cost_micros,status,
          started_at,request_id,budget_reservation_id,created_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
          'DISCOVERY','BACKGROUND_REFRESH','US','en-US',1,'response.v1',
          $5,1,10,'running',$6,$7,$7,'test'
        )
      `, [
        requestId,
        organization,
        workspaceA,
        projectA,
        requestFingerprint,
        observedAt,
        reservationKey,
      ]);
      await createProviderBudgetRepository(client, () => observedAt)
        .recordRequest({
          batchRequestId: requestId,
          context: {
            organizationId: organization,
            workspaceId: workspaceA,
            websiteProjectId: projectA,
            requestId: reservationKey,
            idempotencyKey: reservationKey,
            budgetReservationId: reservationKey,
          },
          endpoint: "endpoint",
          requestFingerprint,
          requestSchemaVersion: 1,
          requestPayload: { reservationKey },
          startedAt: observedAt,
        });
    };

    for (const [index, requestId] of historicalIds.entries()) {
      const key = `${historicalPrefix}:traffic:${index}`;
      await insertRequest(requestId, key, String(index + 1).repeat(64));
      await expect(createProviderBudgetRepository(
        client,
        () => observedAt,
      ).reserveBudgetWithinPaidCallCeiling({
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: key,
          idempotencyKey: key,
          budgetReservationId: key,
        },
        provider: "dataforseo",
        requestFingerprint: String(index + 1).repeat(64),
        reservationKey: key,
        estimatedCostMicros: 10,
      }, 10, 1_000_000)).resolves.toBe("allow");
    }
    const requestKind = (index: number) => [
      "w1:discovery:exact",
      "w1:qualification:traffic",
      "w2:qualification:spam",
      "w2:qualification:rank",
      "w3:qualification:traffic",
    ][index] as string;
    for (const [index, requestId] of operationIds.entries()) {
      await insertRequest(
        requestId,
        `${operationPrefix}:${requestKind(index)}:${index}`,
        String(index + 4).repeat(64),
      );
    }

    const clients = operationIds.map(
      () => new PgClient({ connectionString: harness.connectionString }),
    );
    await Promise.all(clients.map(async (opened) => {
      await opened.connect();
      await configureOwner(opened);
    }));
    const reservationInput = (index: number) => {
      const reservationKey = `${operationPrefix}:${requestKind(index)}:${index}`;
      return {
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: reservationKey,
          idempotencyKey: reservationKey,
          budgetReservationId: reservationKey,
        },
        provider: "dataforseo" as const,
        requestFingerprint: String(index + 4).repeat(64),
        reservationKey,
        estimatedCostMicros: 10,
      };
    };
    try {
      const decisions = await Promise.all(clients.map(async (opened, index) => {
        await opened.query("BEGIN");
        try {
          await opened.query(`
            SELECT set_config('app.current_organization_id',$1,true),
              set_config('app.current_workspace_id',$2,true),
              set_config('app.current_website_project_id',$3,true)
          `, [organization, workspaceA, projectA]);
          const decision = await createProviderBudgetRepository(
            opened,
            () => observedAt,
          ).reserveBudgetWithinOperationCeiling(
            reservationInput(index),
            operationPrefix,
            3,
            1_000_000,
            1_000_000,
          );
          await opened.query("COMMIT");
          return decision;
        } catch (error) {
          await opened.query("ROLLBACK");
          throw error;
        }
      }));
      expect(decisions.filter((decision) => decision === "allow")).toHaveLength(3);
      expect(decisions.filter((decision) => decision === "deny")).toHaveLength(2);

      const allowedIndex = decisions.findIndex(
        (decision) => decision === "allow",
      );
      const replayClient = clients[allowedIndex];
      if (replayClient === undefined) {
        throw new Error("Missing allowed operation reservation client");
      }
      await replayClient.query("BEGIN");
      await replayClient.query(`
        SELECT set_config('app.current_organization_id',$1,true),
          set_config('app.current_workspace_id',$2,true),
          set_config('app.current_website_project_id',$3,true)
      `, [organization, workspaceA, projectA]);
      await expect(createProviderBudgetRepository(
        replayClient,
        () => observedAt,
      ).reserveBudgetWithinOperationCeiling(
        reservationInput(allowedIndex),
        operationPrefix,
        3,
        1_000_000,
        1_000_000,
      )).resolves.toBe("allow");
      await replayClient.query("COMMIT");

      expect((await client.query(`
        SELECT count(*)::integer count
          FROM backlink_provider_usage_ledger
         WHERE budget_id=$1::uuid
           AND status='reserved'
           AND reservation_key LIKE $2 || '%'
      `, [budgetId, `${operationPrefix}:`])).rows).toEqual([{ count: 3 }]);

      const deniedIndex = decisions.findIndex(
        (decision) => decision === "deny",
      );
      const settledRequestId = operationIds[allowedIndex];
      if (deniedIndex < 0 || settledRequestId === undefined) {
        throw new Error("Missing operation ceiling fixture");
      }
      await replayClient.query("BEGIN");
      await replayClient.query(`
        SELECT set_config('app.current_organization_id',$1,true),
          set_config('app.current_workspace_id',$2,true),
          set_config('app.current_website_project_id',$3,true)
      `, [organization, workspaceA, projectA]);
      const repository = createProviderBudgetRepository(
        replayClient,
        () => observedAt,
      );
      await repository.settle({
        batchRequestId: settledRequestId,
        actualCostMicros: 8,
        settledAt: observedAt,
      });
      await expect(repository.reserveBudgetWithinOperationCeiling(
        reservationInput(deniedIndex),
        operationPrefix,
        3,
        1_000_000,
        1_000_000,
      )).resolves.toBe("deny");
      await replayClient.query("COMMIT");

      expect((await client.query(`
        SELECT count(*) FILTER (WHERE status='reserved')::integer reserved,
               count(*) FILTER (WHERE status='settled')::integer settled
          FROM backlink_provider_usage_ledger
         WHERE budget_id=$1::uuid
           AND reservation_key LIKE $2 || '%'
      `, [budgetId, `${operationPrefix}:`])).rows).toEqual([{
        reserved: 2,
        settled: 1,
      }]);
    } finally {
      await Promise.all(clients.map((opened) => opened.end()));
    }
  }, 30_000);

  it("keeps one operation ceiling across daily budget cycles", async () => {
    const firstObservedAt = new Date("2026-08-12T23:59:00.000Z");
    const secondObservedAt = new Date("2026-08-13T00:01:00.000Z");
    const firstBudgetId = id(450);
    const secondBudgetId = id(451);
    const operationPrefix = `commercial-refill-operation:${id(452)}`;
    const firstRequestId = id(453);
    const secondRequestId = id(454);
    const firstKey = `${operationPrefix}:w1:discovery:serp`;
    const secondKey = `${operationPrefix}:w2:qualification:traffic`;

    await client.query(`
      INSERT INTO backlink_provider_budgets (
        id,organization_id,workspace_id,provider,period_start,period_end,
        limit_micros,created_by
      ) VALUES
        (
          $1::uuid,$3::uuid,$4::uuid,'dataforseo',
          '2026-08-12T00:00:00.000Z','2026-08-13T00:00:00.000Z',
          1000000,'test'
        ),
        (
          $2::uuid,$3::uuid,$4::uuid,'dataforseo',
          '2026-08-13T00:00:00.000Z','2026-08-14T00:00:00.000Z',
          1000000,'test'
        )
    `, [firstBudgetId, secondBudgetId, organization, workspaceA]);

    const insertRequest = async (
      requestId: string,
      reservationKey: string,
      requestFingerprint: string,
      observedAt: Date,
    ) => {
      await client.query(`
        INSERT INTO provider_batch_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_intent,refresh_mode,location_code,language_code,
          request_schema_version,response_schema_version,
          normalized_request_hash,request_count,estimated_cost_micros,status,
          started_at,request_id,budget_reservation_id,created_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
          'DISCOVERY','BACKGROUND_REFRESH','ZA','en',1,'response.v1',
          $5,1,10,'running',$6,$7,$7,'test'
        )
      `, [
        requestId,
        organization,
        workspaceA,
        projectA,
        requestFingerprint,
        observedAt,
        reservationKey,
      ]);
      await createProviderBudgetRepository(client, () => observedAt)
        .recordRequest({
          batchRequestId: requestId,
          context: {
            organizationId: organization,
            workspaceId: workspaceA,
            websiteProjectId: projectA,
            requestId: reservationKey,
            idempotencyKey: reservationKey,
            budgetReservationId: reservationKey,
          },
          endpoint: "endpoint",
          requestFingerprint,
          requestSchemaVersion: 1,
          requestPayload: { reservationKey },
          startedAt: observedAt,
        });
    };

    await insertRequest(
      firstRequestId,
      firstKey,
      "a".repeat(64),
      firstObservedAt,
    );
    const firstRepository = createProviderBudgetRepository(
      client,
      () => firstObservedAt,
    );
    await expect(firstRepository.reserveBudgetWithinOperationCeiling(
      {
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: firstKey,
          idempotencyKey: firstKey,
          budgetReservationId: firstKey,
        },
        provider: "dataforseo",
        requestFingerprint: "a".repeat(64),
        reservationKey: firstKey,
        estimatedCostMicros: 10,
      },
      operationPrefix,
      1,
      1_000_000,
      1_000_000,
    )).resolves.toBe("allow");
    await firstRepository.settle({
      batchRequestId: firstRequestId,
      actualCostMicros: 8,
      settledAt: firstObservedAt,
    });
    await expect(createProviderBudgetRepository(
      client,
      () => secondObservedAt,
    ).reserveBudgetWithinOperationCeiling(
      {
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: firstKey,
          idempotencyKey: firstKey,
          budgetReservationId: firstKey,
        },
        provider: "dataforseo",
        requestFingerprint: "a".repeat(64),
        reservationKey: firstKey,
        estimatedCostMicros: 10,
      },
      operationPrefix,
      1,
      1_000_000,
      1_000_000,
    )).resolves.toBe("allow");

    await insertRequest(
      secondRequestId,
      secondKey,
      "b".repeat(64),
      secondObservedAt,
    );
    await expect(createProviderBudgetRepository(
      client,
      () => secondObservedAt,
    ).reserveBudgetWithinOperationCeiling(
      {
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: secondKey,
          idempotencyKey: secondKey,
          budgetReservationId: secondKey,
        },
        provider: "dataforseo",
        requestFingerprint: "b".repeat(64),
        reservationKey: secondKey,
        estimatedCostMicros: 10,
      },
      operationPrefix,
      1,
      1_000_000,
      1_000_000,
    )).resolves.toBe("deny");

    expect((await client.query(`
      SELECT budget_id::text AS "budgetId",status,reservation_key
        FROM backlink_provider_usage_ledger
       WHERE organization_id=$1::uuid
         AND workspace_id=$2::uuid
         AND website_project_id=$3::uuid
         AND reservation_key LIKE $4 || '%'
       ORDER BY reservation_key
    `, [
      organization,
      workspaceA,
      projectA,
      `${operationPrefix}:`,
    ])).rows).toEqual([{
      budgetId: firstBudgetId,
      status: "settled",
      reservation_key: firstKey,
    }]);
  });

  it("atomically preserves paid-call and cost headroom for later qualification", async () => {
    const observedAt = new Date("2026-08-12T10:00:00.000Z");
    const budgetId = id(460);
    const operationPrefix = `commercial-refill-operation:${id(461)}`;
    const requestIds = [id(462), id(463), id(464)];
    await insertBudget(client, workspaceA, budgetId);

    const insertRequest = async (requestId: string, reservationKey: string) => {
      await client.query(`
        INSERT INTO provider_batch_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_intent,refresh_mode,location_code,language_code,
          request_schema_version,response_schema_version,
          normalized_request_hash,request_count,estimated_cost_micros,status,
          started_at,request_id,budget_reservation_id,created_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
          'DISCOVERY','BACKGROUND_REFRESH','ZA','en',1,'response.v1',
          $5,1,10,'running',$6,$7,$7,'test'
        )
      `, [
        requestId,
        organization,
        workspaceA,
        projectA,
        String(Number(requestId.slice(-2)) + 1).repeat(64).slice(0, 64),
        observedAt,
        reservationKey,
      ]);
      await createProviderBudgetRepository(client, () => observedAt)
        .recordRequest({
          batchRequestId: requestId,
          context: {
            organizationId: organization,
            workspaceId: workspaceA,
            websiteProjectId: projectA,
            requestId: reservationKey,
            idempotencyKey: reservationKey,
            budgetReservationId: reservationKey,
          },
          endpoint: "endpoint",
          requestFingerprint:
            String(Number(requestId.slice(-2)) + 1).repeat(64).slice(0, 64),
          requestSchemaVersion: 1,
          requestPayload: { reservationKey },
          startedAt: observedAt,
        });
    };
    const reservationKeys = requestIds.map(
      (_, index) => `${operationPrefix}:discovery:${index}`,
    );
    await Promise.all(requestIds.map((requestId, index) => {
      const reservationKey = reservationKeys[index];
      if (reservationKey === undefined) {
        throw new Error("Missing reservation key for request");
      }
      return insertRequest(requestId, reservationKey);
    }));

    const clients = requestIds.map(
      () => new PgClient({ connectionString: harness.connectionString }),
    );
    await Promise.all(clients.map(async (opened) => {
      await opened.connect();
      await configureOwner(opened);
    }));
    const reservationInput = (index: number) => {
      const reservationKey = reservationKeys[index];
      const requestId = requestIds[index];
      if (reservationKey === undefined || requestId === undefined) {
        throw new Error("Missing request reservation input");
      }
      return {
        context: {
          organizationId: organization,
          workspaceId: workspaceA,
          websiteProjectId: projectA,
          requestId: reservationKey,
          idempotencyKey: reservationKey,
          budgetReservationId: reservationKey,
        },
        provider: "dataforseo" as const,
        requestFingerprint:
          String(Number(requestId.slice(-2)) + 1).repeat(64).slice(0, 64),
        reservationKey,
        estimatedCostMicros: 10,
      };
    };

    try {
      const decisions = await Promise.all(clients.map(async (opened, index) => {
        await opened.query("BEGIN");
        try {
          await opened.query(`
            SELECT set_config('app.current_organization_id',$1,true),
              set_config('app.current_workspace_id',$2,true),
              set_config('app.current_website_project_id',$3,true)
          `, [organization, workspaceA, projectA]);
          const decision = await createProviderBudgetRepository(
            opened,
            () => observedAt,
          ).reserveBudgetWithinOperationCeiling(
            reservationInput(index),
            operationPrefix,
            3,
            30,
            1_000_000,
            {
              requiredRemainingPaidCalls: 2,
              requiredRemainingCostMicros: 20,
            },
          );
          await opened.query("COMMIT");
          return decision;
        } catch (error) {
          await opened.query("ROLLBACK");
          throw error;
        }
      }));
      expect(decisions.filter((decision) => decision === "allow")).toHaveLength(1);
      expect(decisions.filter((decision) => decision === "deny")).toHaveLength(2);

      const allowedIndex = decisions.findIndex(
        (decision) => decision === "allow",
      );
      const replayClient = clients[allowedIndex];
      if (replayClient === undefined) {
        throw new Error("Missing allowed headroom reservation client");
      }
      await replayClient.query("BEGIN");
      await replayClient.query(`
        SELECT set_config('app.current_organization_id',$1,true),
          set_config('app.current_workspace_id',$2,true),
          set_config('app.current_website_project_id',$3,true)
      `, [organization, workspaceA, projectA]);
      await expect(createProviderBudgetRepository(
        replayClient,
        () => observedAt,
      ).reserveBudgetWithinOperationCeiling(
        reservationInput(allowedIndex),
        operationPrefix,
        3,
        30,
        1_000_000,
        {
          requiredRemainingPaidCalls: 2,
          requiredRemainingCostMicros: 20,
        },
      )).resolves.toBe("allow");
      await replayClient.query("COMMIT");

      expect((await client.query(`
        SELECT count(*)::integer count
          FROM backlink_provider_usage_ledger
         WHERE budget_id=$1::uuid
           AND status='reserved'
           AND reservation_key LIKE $2 || '%'
      `, [budgetId, `${operationPrefix}:`])).rows).toEqual([{ count: 1 }]);
    } finally {
      await Promise.all(clients.map((opened) => opened.end()));
    }
  }, 30_000);

  it("replenishes the formal daily and operation windows for persistent discovery", async () => {
    const observedAt = new Date("2026-08-12T11:00:00.000Z");
    const budgetId = id(465);
    const requestId = id(466);
    const operationPrefix = `commercial-refill-operation:${id(467)}`;
    const reservationKey = `${operationPrefix}:discovery:semantic`;
    const requestFingerprint = "7".repeat(64);
    await insertBudget(client, workspaceA, budgetId);
    await client.query(
      "UPDATE backlink_provider_budgets SET limit_micros=10 WHERE id=$1::uuid",
      [budgetId],
    );
    await client.query(`
      INSERT INTO provider_batch_requests (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        request_intent,refresh_mode,location_code,language_code,
        request_schema_version,response_schema_version,
        normalized_request_hash,request_count,estimated_cost_micros,status,
        started_at,request_id,budget_reservation_id,created_by
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
        'DISCOVERY','BACKGROUND_REFRESH','ZA','en',1,'response.v1',
        $5,1,10,'running',$6,$7,$7,'test'
      )
    `, [
      requestId,
      organization,
      workspaceA,
      projectA,
      requestFingerprint,
      observedAt,
      reservationKey,
    ]);
    const repository = createProviderBudgetRepository(client, () => observedAt);
    await repository.recordRequest({
      batchRequestId: requestId,
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: reservationKey,
        idempotencyKey: reservationKey,
        budgetReservationId: reservationKey,
      },
      endpoint: "endpoint",
      requestFingerprint,
      requestSchemaVersion: 1,
      requestPayload: { reservationKey },
      startedAt: observedAt,
    });

    await expect(repository.reserveBudgetWithinOperationCeiling({
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: reservationKey,
        idempotencyKey: reservationKey,
        budgetReservationId: reservationKey,
      },
      provider: "dataforseo",
      requestFingerprint,
      reservationKey,
      estimatedCostMicros: 10,
    }, operationPrefix, 1, 10, 10, {
      requiredRemainingPaidCalls: 3,
      requiredRemainingCostMicros: 30,
      authorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 1,
        maxCostMicros: 10,
        authorizedBy: "integration-test",
      },
    })).resolves.toBe("deny");

    expect((await client.query(`
      SELECT limit_micros AS "limitMicros",
             reserved_micros AS "reservedMicros"
        FROM backlink_provider_budgets
       WHERE id=$1::uuid
    `, [budgetId])).rows).toEqual([{
      limitMicros: "10",
      reservedMicros: "0",
    }]);
    expect((await client.query(`
      SELECT status,reservation_key
        FROM backlink_provider_usage_ledger
       WHERE budget_id=$1::uuid
    `, [budgetId])).rows).toEqual([]);
  });

  it("creates a bounded UTC daily budget when the prior cycle expired", async () => {
    const observedAt = new Date("2028-08-12T08:00:00.000Z");
    const requestId = id(396);
    const requestFingerprint = "9".repeat(64);
    const reservationKey = "daily-budget-cycle";
    await client.query(`
      INSERT INTO provider_batch_requests (
        id,organization_id,workspace_id,website_project_id,provider,endpoint,
        request_intent,refresh_mode,location_code,language_code,
        request_schema_version,response_schema_version,
        normalized_request_hash,request_count,estimated_cost_micros,status,
        started_at,request_id,budget_reservation_id,created_by
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo','endpoint',
        'DISCOVERY','BACKGROUND_REFRESH','US','en-US',1,'response.v1',
        $5,1,10,'running',$6,$7,$8,'test'
      )
    `, [
      requestId,
      organization,
      workspaceA,
      projectA,
      requestFingerprint,
      observedAt,
      "daily-budget-request",
      reservationKey,
    ]);
    const repository = createProviderBudgetRepository(client, () => observedAt);
    await repository.recordRequest({
      batchRequestId: requestId,
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: "daily-budget-request",
        idempotencyKey: reservationKey,
        budgetReservationId: reservationKey,
      },
      endpoint: "endpoint",
      requestFingerprint,
      requestSchemaVersion: 1,
      requestPayload: { cycle: "daily" },
      startedAt: observedAt,
    });

    await expect(repository.reserveBudgetWithinPaidCallCeiling({
      context: {
        organizationId: organization,
        workspaceId: workspaceA,
        websiteProjectId: projectA,
        requestId: "daily-budget-request",
        idempotencyKey: reservationKey,
        budgetReservationId: reservationKey,
      },
      provider: "dataforseo",
      requestFingerprint,
      reservationKey,
      estimatedCostMicros: 10,
    }, 3, 1_000_000)).resolves.toBe("allow");

    expect((await client.query(`
      SELECT period_start AS "periodStart",period_end AS "periodEnd",
             limit_micros AS "limitMicros",reserved_micros AS "reservedMicros"
        FROM backlink_provider_budgets
       WHERE organization_id=$1::uuid AND workspace_id=$2::uuid
         AND provider='dataforseo'
         AND period_start<=$3 AND period_end>$3
    `, [organization, workspaceA, observedAt])).rows).toEqual([{
      periodStart: new Date("2028-08-12T00:00:00.000Z"),
      periodEnd: new Date("2028-08-13T00:00:00.000Z"),
      limitMicros: "1000000",
      reservedMicros: "10",
    }]);
  });

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
      gate: {
        preflight: async () => undefined,
        authorize: async () => undefined,
      },
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
