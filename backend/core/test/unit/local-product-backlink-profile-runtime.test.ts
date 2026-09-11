import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { checkProviderExecutionCeiling } from "../../src/modules/backlinks/db/repositories/provider-budget.repository.js";

import type {
  BacklinkTenantPool,
  BacklinkTenantPoolClient,
} from "../../src/modules/backlinks/db/tenant-transaction.js";
import {
  createLocalProductBacklinkProfileRuntime,
} from "../../src/modules/backlinks/runtime/local-product-backlink-profile-runtime.js";
import {
  readLocalProductDataForSeoConfiguration,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";

const configurationEnvironment = {
  DATAFORSEO_CREDENTIAL_SECRET_REF:
    "secret://growthos/local-product/dataforseo/provider-credential/v7",
  DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
    "https://api.dataforseo.com/v3/backlinks/summary/live",
    "https://api.dataforseo.com/v3/backlinks/backlinks/live",
  ]),
  DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
  DATAFORSEO_ESTIMATED_COST_MICROS: "50000",
  DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "100000",
  DATAFORSEO_MAX_PAID_CALLS: "25",
  DATAFORSEO_CANDIDATE_LIMIT: "20",
  DATAFORSEO_EXTERNAL_AVAILABILITY: "unavailable",
  DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON: "explicit_block",
} as const;

describe("local product backlink profile runtime", () => {
  it("checks the combined profile estimate under the shared execution lock", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("exposureMicros")
        ? [{ exposureMicros: 60000, alreadyReserved: false }] : [],
    }));
    await expect(checkProviderExecutionCeiling({ query }, {
      context: { organizationId: "org", workspaceId: "workspace", websiteProjectId: "project" },
      provider: "dataforseo",
      reservationKey: "backlink-profile:job:combined",
      estimatedCostMicros: 50000,
    }, { startedAt: "2026-09-08T02:00:00Z", limitMicros: 100000 },
    () => new Date("2026-09-08T03:00:00Z"))).resolves.toBe("deny");
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
    const source = await readFile(new URL(
      "../../src/modules/backlinks/runtime/local-product-backlink-profile-runtime.ts",
      import.meta.url,
    ), "utf8");
    expect(source).toContain("estimatedCostMicros: configuration.estimatedCostMicros * 2");
    expect(source.indexOf("const ceiling = await checkProviderExecutionCeiling"))
      .toBeLessThan(source.indexOf("const budget = await client.query"));
    expect(source).toContain('if (ceiling === "deny") return null');
  });
  it("persists external unavailability before credentials or paid work", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const client: BacklinkTenantPoolClient = { query, release };
    const pool: BacklinkTenantPool = {
      connect: vi.fn(async () => client),
    };
    const runtime = createLocalProductBacklinkProfileRuntime({
      pool,
      secretStoreRoot: "C:\\missing-secret-store",
      configuration: readLocalProductDataForSeoConfiguration(
        configurationEnvironment,
      ),
    });

    await expect(runtime.execute({
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      websiteProjectId: "33333333-3333-4333-8333-333333333333",
      profileSyncJobId: "44444444-4444-4444-8444-444444444444",
      canonicalDomain: "example.com",
    })).resolves.toEqual({
      status: "waiting_provider",
      providerInputRequired: true,
    });

    const sql = query.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).toContain("error_code=$5");
    expect(query.mock.calls.some(([, values]) =>
      Array.isArray(values) && values.includes("explicit_block")
    )).toBe(true);
    expect(sql).not.toContain("backlink_provider_budgets");
    expect(sql).not.toContain("backlink_provider_requests");
    expect(sql).not.toContain("backlink_reserve_provider_cost");
    expect(release).toHaveBeenCalledOnce();
  });
});
