import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createRecommendationHybridSupplyRuntime } from "../../src/modules/backlinks/runtime/recommendation-hybrid-supply-runtime.js";
import { withBacklinkTenantTransaction, type BacklinkTransactionClient } from "../../src/modules/backlinks/db/tenant-transaction.js";

const input = {
  organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
  generationContractId: "generation", recommendationContextVersionId: "context",
  visiblePoolGeneration: 1, inputPinId: "pin", actorId: "worker",
  discoveryTerminalReason: "EXHAUSTED" as const,
};
const mocks = vi.hoisted(() => ({ match: vi.fn(async () => []) }));
vi.mock("../../src/modules/backlinks/adapters/resource-library/sqlite-resource-library.adapter.js", () => ({
  createSqliteResourceLibraryAdapter: () => ({ match: mocks.match }),
}));

function fixture(options: { finalized?: boolean; cached?: boolean; admitted?: number; cacheUnavailable?: boolean } = {}) {
  let active = 0;
  let finalized = options.finalized ?? false;
  const log: string[] = [];
  const scopes: (readonly unknown[] | undefined)[] = [];
  const query: BacklinkTransactionClient["query"] = async (sql, values) => {
    log.push(sql);
    if (options.cacheUnavailable && sql.includes("backlink_project_domain_ratings")) throw new Error("private SQL error");
    if (sql.includes("set_config")) scopes.push(values);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('AS "effectiveCount"')) rows = [{ effectiveCount: finalized ? 120 : null,
      projectDomain: "aiper.com", language: "en", keywords: ["pool"], products: [], categories: [] }];
    else if (sql.includes("AS admitted")) rows = [{ admitted: options.admitted ?? 120, dfs: options.admitted ?? 120 }];
    else if (sql.includes("UNION SELECT")) rows = [{ domain: "old.com" }];
    else if (sql.includes("ORDER BY id FOR UPDATE")) rows = [{ id: "context" }];
    else if (sql.includes('expires_at AS "expiresAt"') && options.cached !== false) rows = [{
      target: "aiper.com", value: 61, observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), failureCode: null,
    }];
    return { rows, rowCount: rows.length };
  };
  const pool = { connect: vi.fn(async () => {
    if (active !== 0) throw new Error("NESTED_POOL_CONNECTION");
    active += 1;
    return { query, release: () => { active -= 1; } };
  }) };
  const prepare = createRecommendationHybridSupplyRuntime({
    pool, secretStoreRoot: null, environment: { RESOURCE_LIBRARY_SQLITE_PATH: "C:/fixture.sqlite" },
  });
  if (prepare === undefined) throw new Error("Fixture runtime must be configured");
  return { pool, log, scopes, prepare, finalize: () => { finalized = true; }, active: () => active };
}

describe("hybrid supply runtime transaction boundaries", () => {
  it("wires opt-in settings into local startup and keeps migration 0100 atomic", async () => {
    const startup = await readFile(new URL("../../../../scripts/dev-up.ps1", import.meta.url), "utf8");
    expect(startup).toContain('RESOURCE_LIBRARY_SQLITE_PATH = Get-LocalSetting "RESOURCE_LIBRARY_SQLITE_PATH"');
    expect(startup).toContain('AHREFS_CREDENTIAL_SECRET_REF = Get-LocalSetting "AHREFS_CREDENTIAL_SECRET_REF"');
    expect(startup).toContain("THEN '0100'");
    expect(startup).toContain("THEN '0099'");
    const migration = await readFile(new URL(
      "../../src/modules/backlinks/db/migrations/0100_backlink_hybrid_batch_release.sql", import.meta.url,
    ), "utf8");
    expect(migration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/u);
    expect(migration).toContain("SET LOCAL ROLE growthos_backlinks_owner;");
  });
  it("uses the bundled library by default and permits explicit disable", () => {
    expect(createRecommendationHybridSupplyRuntime({ pool: { connect: vi.fn() }, secretStoreRoot: null, environment: {} })).toBeTypeOf("function");
    expect(createRecommendationHybridSupplyRuntime({ pool: { connect: vi.fn() }, secretStoreRoot: null, environment: { RESOURCE_LIBRARY_ENABLED: "false" } })).toBeUndefined();
  });
  it("uses one connection at a time and reuses cached project DR", async () => {
    const subject = fixture();
    mocks.match.mockClear();
    const ingest = await subject.prepare(input);
    expect(subject.active()).toBe(0);
    expect(await withBacklinkTenantTransaction(subject.pool, input, ingest)).toEqual({ status: "EXHAUSTED", admittedCount: 0 });
    expect(subject.scopes).toEqual(Array.from({ length: 3 }, () => ["org", "workspace", "project"]));
    expect(mocks.match).toHaveBeenCalledWith(expect.objectContaining({
      projectDomain: "aiper.com", projectDr: 61, excludedDomains: ["old.com"], limit: 40,
    }));
  });
  it("rechecks finalization after cache preparation and skips replay writes", async () => {
    const subject = fixture();
    const ingest = await subject.prepare(input);
    subject.finalize();
    mocks.match.mockClear();
    expect(await withBacklinkTenantTransaction(subject.pool, input, ingest)).toEqual({ status: "ALREADY_FINALIZED", admittedCount: 0 });
    expect(mocks.match).not.toHaveBeenCalled();
  });
  it("skips the cache transaction entirely for an already finalized generation", async () => {
    const subject = fixture({ finalized: true });
    await subject.prepare(input);
    expect(subject.pool.connect).toHaveBeenCalledTimes(1);
    expect(subject.log.some((sql) => sql.includes("backlink_project_domain_ratings"))).toBe(false);
  });
  it("commits a missing-credential failure cache while preserving existing DFS supply", async () => {
    const subject = fixture({ cached: false });
    const ingest = await subject.prepare(input);
    const cacheWrite = subject.log.findIndex((sql) => sql.includes("INSERT INTO backlinks.backlink_project_domain_ratings"));
    expect(cacheWrite).toBeGreaterThan(0);
    expect(subject.log[cacheWrite + 1]).toBe("COMMIT");
    expect(await withBacklinkTenantTransaction(subject.pool, input, ingest)).toEqual({
      status: "BLOCKED", admittedCount: 0, reason: "AHREFS_CREDENTIAL_UNAVAILABLE",
    });
  });
  it("does not block existing DFS or leak SQL errors when cache storage is unavailable", async () => {
    const subject = fixture({ cacheUnavailable: true });
    const ingest = await subject.prepare(input);
    expect(await withBacklinkTenantTransaction(subject.pool, input, ingest)).toEqual({
      status: "BLOCKED", admittedCount: 0, reason: "AHREFS_CACHE_UNAVAILABLE",
    });
  });
});
