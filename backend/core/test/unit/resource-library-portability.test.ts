import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { bundledDirectory, exportBundle, publisherColumns, verifyBundle } from "../../scripts/resource-library-bundle.mjs";
import { resolveResourceLibraryPath } from "../../src/modules/backlinks/runtime/resource-library-location.js";
import { createSqliteResourceLibraryAdapter } from "../../src/modules/backlinks/adapters/resource-library/sqlite-resource-library.adapter.js";

const folders: string[] = [];
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "growthos-portable-library-"));
  folders.push(path);
  return path;
}
function copyBundle(destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const name of ["publishers.sqlite", "manifest.json"]) {
    copyFileSync(join(bundledDirectory, name), join(destination, name));
  }
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("repository-owned resource library", () => {
  it("exports every publisher row without importing private metadata or unknown columns", () => {
    const root = temporaryDirectory();
    const sourcePath = join(root, "source.sqlite");
    const db = new DatabaseSync(sourcePath);
    db.exec(`CREATE TABLE publishers (${Object.entries(publisherColumns).map(([name, type]) => `${name} ${type}`).join(",")}, private_token TEXT);
      CREATE TABLE publisher_import_metadata (private_path TEXT);
      INSERT INTO publisher_import_metadata VALUES ('PRIVATE_METADATA_SENTINEL');`);
    const insert = db.prepare(`INSERT INTO publishers
      (website,domain,categories_json,ahrefs_dr,monthly_traffic,language,private_token) VALUES (?,?,?,?,?,?,?)`);
    insert.run("zero.example", "zero.example", '["Technology"]', 0, null, "English", "PRIVATE_TOKEN_SENTINEL");
    insert.run("zero.example", "zero.example", '["Technology"]', null, 0, "English", "PRIVATE_TOKEN_SENTINEL");
    db.close();
    const before = readFileSync(sourcePath);
    const output = join(root, "export");
    expect(exportBundle(sourcePath, output)).toMatchObject({ rowCount: 2, distinctDomains: 1 });
    expect(readFileSync(sourcePath)).toEqual(before);
    const bytes = readFileSync(join(output, "publishers.sqlite"));
    expect(bytes.includes(Buffer.from("PRIVATE_"))).toBe(false);
    const result = new DatabaseSync(join(output, "publishers.sqlite"), { readOnly: true });
    try {
      expect(result.prepare("SELECT ahrefs_dr FROM publishers ORDER BY ahrefs_dr").all())
        .toEqual([{ ahrefs_dr: null }, { ahrefs_dr: 0 }]);
    } finally { result.close(); }
    expect(() => exportBundle(sourcePath, output)).toThrow("RESOURCE_LIBRARY_BUNDLE_ALREADY_EXISTS");
    expect(verifyBundle(output).rowCount).toBe(2);
  });

  it("contains the full real publisher catalog and detects corruption", () => {
    expect(verifyBundle()).toMatchObject({ rowCount: 49_742, distinctDomains: 49_737 });
    const relocated = join(temporaryDirectory(), "bundle");
    copyBundle(relocated);
    const path = join(relocated, "publishers.sqlite");
    const bytes = readFileSync(path);
    bytes[0] = 0;
    writeFileSync(path, bytes);
    expect(() => verifyBundle(relocated)).toThrow("RESOURCE_LIBRARY_BUNDLE_CHECKSUM_MISMATCH");
  });

  it("resolves defaults and overrides independently of the shell directory", () => {
    const root = temporaryDirectory();
    expect(resolveResourceLibraryPath({})).toBe(resolve(bundledDirectory, "publishers.sqlite"));
    expect(resolveResourceLibraryPath({}, root)).toBe(join(root, "resources/resource-library/bundled/publishers.sqlite"));
    expect(resolveResourceLibraryPath({ RESOURCE_LIBRARY_SQLITE_PATH: "custom/catalog.sqlite" }, root))
      .toBe(join(root, "custom/catalog.sqlite"));
    expect(resolveResourceLibraryPath({ RESOURCE_LIBRARY_SQLITE_PATH: join(root, "absolute.sqlite") }))
      .toBe(join(root, "absolute.sqlite"));
    expect(resolveResourceLibraryPath({ RESOURCE_LIBRARY_ENABLED: "false" }, root)).toBeUndefined();
  });

  it("matches from a relocated checkout without the author's external SQLite path", async () => {
    const root = temporaryDirectory();
    const destination = join(root, "resources/resource-library/bundled");
    copyBundle(destination);
    const path = resolveResourceLibraryPath({}, root);
    if (!path) throw new Error("Bundled library must be enabled");
    const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = digest();
    const result = await createSqliteResourceLibraryAdapter(path).match({
      projectDomain: "aiper.com", projectDr: 61, language: "en-US",
      topics: ["robotic pool cleaners"], excludedDomains: [], limit: 1000,
    });
    expect(result).toHaveLength(1000);
    expect(new Set(result.map((row) => row.canonicalDomain)).size).toBe(1000);
    expect(result.filter((row) => row.ahrefsDr >= 60)).toHaveLength(400);
    expect(digest()).toBe(before);
    await expect(createSqliteResourceLibraryAdapter(join(root, "missing.sqlite")).match({
      projectDomain: "aiper.com", projectDr: 61, language: "en", topics: [], excludedDomains: [], limit: 1,
    })).rejects.toThrow("RESOURCE_LIBRARY_UNAVAILABLE");
  });
});
