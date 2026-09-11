import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteResourceLibraryAdapter, resourceLibraryDrPolicy } from "../../src/modules/backlinks/adapters/resource-library/sqlite-resource-library.adapter.js";
import type { ResourceLibraryMatchInput } from "../../src/modules/backlinks/ports/resource-library.port.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

type Row = [domain: string, language: string, dr: number | null, traffic: number | null, category: string];
function fixture(rows: Row[]) {
  const folder = mkdtempSync(join(tmpdir(), "growthos-library-test-"));
  folders.push(folder);
  const path = join(folder, "publishers.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE publishers (domain TEXT, language TEXT, ahrefs_dr INTEGER, monthly_traffic INTEGER, categories_json TEXT); CREATE INDEX publishers_metrics_idx ON publishers(ahrefs_dr); BEGIN");
  const insert = db.prepare("INSERT INTO publishers VALUES (?,?,?,?,?)");
  for (const [domain, language, dr, traffic, category] of rows) insert.run(domain, language, dr, traffic, JSON.stringify([category]));
  db.exec("COMMIT");
  db.close();
  return { path, adapter: createSqliteResourceLibraryAdapter(path) };
}
const input: ResourceLibraryMatchInput = {
  projectDomain: "aiper.com", projectDr: 61, language: "en-US",
  topics: ["robotic pool cleaners"], excludedDomains: [], limit: 100,
};
const row = (domain: string, dr: number | null = 45, category = "Home and Family"): Row =>
  [domain, "English", dr, null, category];

describe("bounded read-only resource library", () => {
  it("filters before LIMIT, skips giants/subdomains and canonicalizes history", async () => {
    const rows: Row[] = Array.from({ length: 1_100 }, (_, index) => [`unrelated${index}.com`, "German", 80, 10, "Finance"]);
    rows.push(row("store.apple.com"), row("android.com"), row("www.amazon.com"), row("aiper.com"),
      row("old.com"), row("www.good.com"), row("blog.good.com"), row("missing.com", null), row("winner.com"));
    const { adapter } = fixture(rows);
    const result = await adapter.match({ ...input, excludedDomains: ["https://www.old.com/page"], limit: 2 });
    expect(result.map((item) => item.canonicalDomain)).toEqual(["good.com", "winner.com"]);
    expect(result[0]).toMatchObject({ ahrefsDr: 45, monthlyTraffic: null, categoryMatch: "RELATED" });
  });
  it("leaves the original SQLite bytes untouched and returns deterministic results", async () => {
    const { adapter, path } = fixture([row("a.com"), row("b.com")]);
    const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = hash();
    expect(await adapter.match(input)).toEqual(await adapter.match(input));
    expect(hash()).toBe(before);
  });
  it.each([0, 19.9, 20, 39.9, 40, 59.9, 60, 100])("caps high DR based on actual supply for project DR %s", async (dr) => {
    const { adapter } = fixture([
      ...Array.from({ length: 11 }, (_, i) => row(`low${i}.com`)),
      ...Array.from({ length: 100 }, (_, i) => row(`high${i}.com`, 75)),
    ]);
    const result = await adapter.match({ ...input, projectDr: dr });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(100);
    expect(result.filter((value) => value.ahrefsDr >= 60).length)
      .toBeLessThanOrEqual(Math.floor(result.length * resourceLibraryDrPolicy(dr).highRatio));
  });
  it("never fills a high-DR-only result by violating the percentage", async () => {
    const { adapter } = fixture([row("high.com", 80)]);
    expect(await adapter.match(input)).toEqual([]);
  });
  it("keeps unknown project categories unconfirmed rather than claiming overlap", async () => {
    const { adapter } = fixture([row("unknown.com", 45, "Finance")]);
    expect(await adapter.match({ ...input, topics: ["unmapped niche"] }))
      .toEqual([expect.objectContaining({ categoryMatch: "UNCONFIRMED" })]);
  });
  it("ranks related categories before adjacent categories", async () => {
    const { adapter } = fixture([row("general.com", 55, "General"), row("related.com", 45)]);
    expect((await adapter.match(input)).map((item) => item.canonicalDomain)).toEqual(["related.com", "general.com"]);
  });
  it("prioritizes a low project's preferred range before widening", async () => {
    const { adapter } = fixture([row("wide.com", 45), row("preferred.com", 15)]);
    expect((await adapter.match({ ...input, projectDr: 0, limit: 1 }))[0]?.canonicalDomain).toBe("preferred.com");
  });
  it("retains DR zero, not missing DR", async () => {
    const { adapter } = fixture([row("zero.com", 0), row("missing.com", null)]);
    expect(await adapter.match({ ...input, projectDr: 0 })).toEqual([expect.objectContaining({ ahrefsDr: 0 })]);
  });
  it("caps the final unique candidate set at 1000", async () => {
    const { adapter } = fixture(Array.from({ length: 1_100 }, (_, i) => row(`publisher${i}.com`)));
    const result = await adapter.match({ ...input, limit: 1_000 });
    expect(result).toHaveLength(1_000);
    expect(new Set(result.map((value) => value.canonicalDomain)).size).toBe(1_000);
  });
  it("qualifies a 50000-row fixture within the bounded background query budget", async () => {
    const { adapter } = fixture(Array.from({ length: 50_000 }, (_, i) => row(`publisher${i}.com`, i % 101)));
    const startedAt = performance.now();
    const result = await adapter.match({ ...input, limit: 1_000 });
    const elapsedMs = performance.now() - startedAt;
    expect(result).toHaveLength(1_000);
    expect(elapsedMs).toBeLessThan(2_000);
    console.info(`Resource-library fixture: 50000 rows, ${result.length} selected, ${elapsedMs.toFixed(2)}ms`);
  });
  it("reports inaccessible files and unsupported languages distinctly from exhaustion", async () => {
    const { adapter, path } = fixture([]);
    await expect(adapter.match({ ...input, language: "xx" })).rejects.toThrow("RESOURCE_LIBRARY_LANGUAGE_UNSUPPORTED");
    await expect(createSqliteResourceLibraryAdapter(`${path}.missing`).match(input)).rejects.toThrow("RESOURCE_LIBRARY_UNAVAILABLE");
    await expect(createSqliteResourceLibraryAdapter("relative.sqlite").match(input)).rejects.toThrow("RESOURCE_LIBRARY_UNAVAILABLE");
    expect(await adapter.match(input)).toEqual([]);
  });
});
