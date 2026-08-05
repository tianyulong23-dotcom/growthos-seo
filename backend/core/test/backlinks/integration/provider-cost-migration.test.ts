import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkProviderBudgets,
  backlinkProviderUsageLedger,
} from "../../../src/modules/backlinks/db/schema/provider-seo.js";
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
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0002_backlink_provider_seo.sql",
  import.meta.url,
);
const ids = {
  organization: "018f0000-0000-7000-8000-000000000001",
  workspace: "018f0000-0000-7000-8000-000000000002",
  projectA: "018f0000-0000-7000-8000-000000000003",
  projectB: "018f0000-0000-7000-8000-000000000004",
  budget: "018f0000-0000-7000-8000-000000000201",
  requestA: "018f0000-0000-7000-8000-000000000202",
  requestB: "018f0000-0000-7000-8000-000000000203",
  ledgerA: "018f0000-0000-7000-8000-000000000204",
  ledgerB: "018f0000-0000-7000-8000-000000000205",
};
const reserve = (
  client: Client, ledgerId: string, projectId: string,
  requestId: string, reservationKey: string,
) => client.query(`
  SELECT backlink_reserve_provider_cost(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    $7::text, $8::text, $9::bigint, $10::text
  ) AS ledger_id
`, [
  ledgerId, ids.budget, ids.organization, ids.workspace, projectId, requestId,
  "dataforseo", reservationKey, 60, "test",
]);

describe("BL-AI-045 provider cost schema", () => {
  it("declares budget and usage ledger identities", () => {
    const budget = getTableConfig(backlinkProviderBudgets);
    const ledger = getTableConfig(backlinkProviderUsageLedger);
    expect([budget.name, ledger.name]).toEqual([
      "backlink_provider_budgets",
      "backlink_provider_usage_ledger",
    ]);
    expect(budget.indexes.map(({ config }) => config.name)).toContain(
      "backlink_provider_budget_period_uq",
    );
    expect(ledger.indexes.map(({ config }) => config.name)).toContain(
      "backlink_provider_usage_reservation_uq",
    );
    expect(ledger.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "backlink_provider_usage_budget_fk",
        "backlink_provider_usage_request_fk",
      ]),
    );
  });
});

describe("BL-AI-045 provider cost migration", () => {
  let harness: BacklinksPostgresHarness;
  let owner: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    owner = new PgClient({ connectionString: harness.connectionString });
    await owner.connect();
    await owner.query(await readFile(migrationPath, "utf8"));
    await owner.query(`
      INSERT INTO backlink_provider_budgets (
        id, organization_id, workspace_id, provider, period_start, period_end,
        limit_micros, created_by
      ) VALUES (
        '${ids.budget}', '${ids.organization}', '${ids.workspace}',
        'dataforseo', '2026-07-01', '2026-08-01', 100, 'test'
      );
      INSERT INTO backlink_provider_requests (
        id, organization_id, workspace_id, website_project_id, provider,
        endpoint, request_fingerprint, active_request_bucket,
        request_schema_version, request_payload, created_by
      ) VALUES
        (
          '${ids.requestA}', '${ids.organization}', '${ids.workspace}',
          '${ids.projectA}', 'dataforseo', 'backlinks.summary',
          '${"a".repeat(64)}', '2026-07-22T00', 1, '{}', 'test'
        ),
        (
          '${ids.requestB}', '${ids.organization}', '${ids.workspace}',
          '${ids.projectB}', 'dataforseo', 'backlinks.summary',
          '${"b".repeat(64)}', '2026-07-22T00', 1, '{}', 'test'
        );
    `);
  }, 120_000);
  afterAll(async () => {
    await owner?.end();
    await harness?.stop();
  });

  it("atomically prevents concurrent projects from exceeding a workspace budget", async () => {
    const clients = [
      new PgClient({ connectionString: harness.connectionString }),
      new PgClient({ connectionString: harness.connectionString }),
    ];
    await Promise.all(clients.map((client) => client.connect()));
    try {
      const attempts = await Promise.allSettled([
        reserve(clients[0], ids.ledgerA, ids.projectA, ids.requestA, "run-a"),
        reserve(clients[1], ids.ledgerB, ids.projectB, ids.requestB, "run-b"),
      ]);
      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "P0001", message: "BACKLINK_PROVIDER_BUDGET_EXCEEDED" },
      });

      const budget = await owner.query(`
        SELECT spent_micros, reserved_micros
          FROM backlink_provider_budgets
         WHERE id = '${ids.budget}'
      `);
      const ledger = await owner.query(`
        SELECT id, website_project_id, provider_request_id, reservation_key
          FROM backlink_provider_usage_ledger
         WHERE budget_id = '${ids.budget}'
      `);
      expect(budget.rows).toEqual([{ spent_micros: "0", reserved_micros: "60" }]);
      expect(ledger.rows).toHaveLength(1);
      expect([ids.projectA, ids.projectB]).toContain(
        ledger.rows[0]?.website_project_id,
      );

      const row = ledger.rows[0] ?? {};
      await reserve(
        clients[0], String(row.id), String(row.website_project_id),
        String(row.provider_request_id), String(row.reservation_key),
      );
      expect((await owner.query(`
        SELECT reserved_micros FROM backlink_provider_budgets
         WHERE id = '${ids.budget}'
      `)).rows).toEqual([{ reserved_micros: "60" }]);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("enables forced RLS on budget and usage tables", async () => {
    const rls = await owner.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             count(p.policyname)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policies p
          ON p.schemaname = n.nspname AND p.tablename = c.relname
       WHERE n.nspname = current_schema()
         AND c.relname IN (
           'backlink_provider_budgets',
           'backlink_provider_usage_ledger'
         )
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
    `);
    expect(rls.rows).toHaveLength(2);
    expect(rls.rows.every((row) =>
      row.relrowsecurity === true &&
      row.relforcerowsecurity === true &&
      row.policies === 1,
    )).toBe(true);
  });
});
