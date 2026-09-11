import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const bundledDirectory = fileURLToPath(new URL("../resources/resource-library/bundled/", import.meta.url));
export const publisherColumns = Object.freeze({
  website_id: "TEXT", website: "TEXT NOT NULL", domain: "TEXT", website_url: "TEXT",
  categories_json: "TEXT NOT NULL", monthly_traffic: "INTEGER", ahrefs_dr: "INTEGER",
  moz_da: "INTEGER", language: "TEXT", price: "REAL", currency: "TEXT",
  max_links: "INTEGER", link_type: "TEXT", turnaround: "TEXT", added_on: "TEXT",
  source_page: "INTEGER",
});
const names = Object.keys(publisherColumns);
const selectRows = `SELECT ${names.join(",")} FROM publishers ORDER BY ${names.join(",")}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function facts(db) {
  const rows = db.prepare(selectRows).all();
  return {
    rowCount: rows.length,
    distinctDomains: Number(db.prepare("SELECT count(DISTINCT domain) AS n FROM publishers").get().n),
    contentSha256: sha256(JSON.stringify(rows)),
  };
}

export function verifyBundle(directory = bundledDirectory) {
  const path = join(directory, "publishers.sqlite");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.formatVersion !== 1 || manifest.sha256 !== sha256(readFileSync(path))) {
    throw new Error("RESOURCE_LIBRARY_BUNDLE_CHECKSUM_MISMATCH");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const columns = db.prepare("PRAGMA table_info(publishers)").all().map((column) => column.name);
    if (JSON.stringify(tables) !== JSON.stringify([{ name: "publishers" }])
      || JSON.stringify(columns) !== JSON.stringify(names)) {
      throw new Error("RESOURCE_LIBRARY_BUNDLE_SCHEMA_MISMATCH");
    }
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
      throw new Error("RESOURCE_LIBRARY_BUNDLE_INTEGRITY_FAILED");
    }
    const actual = facts(db);
    if (actual.rowCount === 0 || Object.entries(actual).some(([key, value]) => manifest[key] !== value)) {
      throw new Error("RESOURCE_LIBRARY_BUNDLE_CONTENT_MISMATCH");
    }
    return manifest;
  } finally {
    db.close();
  }
}

export function exportBundle(sourcePath, directory = bundledDirectory) {
  const destination = join(directory, "publishers.sqlite");
  const manifestPath = join(directory, "manifest.json");
  // Refuse replacement: refresh into a new directory, verify, then review the diff.
  if (existsSync(destination) || existsSync(manifestPath)) throw new Error("RESOURCE_LIBRARY_BUNDLE_ALREADY_EXISTS");
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  let output;
  let created = false;
  let manifestCreated = false;
  try {
    source.exec("BEGIN");
    const expected = facts(source);
    if (expected.rowCount === 0) throw new Error("RESOURCE_LIBRARY_SOURCE_EMPTY");
    mkdirSync(directory, { recursive: true });
    closeSync(openSync(destination, "wx"));
    created = true;
    output = new DatabaseSync(destination);
    output.exec(`BEGIN; CREATE TABLE publishers (${Object.entries(publisherColumns)
      .map(([name, type]) => `${name} ${type}`).join(",")});`);
    const insert = output.prepare(`INSERT INTO publishers (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
    for (const row of source.prepare(selectRows).iterate()) insert.run(...names.map((name) => row[name]));
    output.exec("CREATE INDEX publishers_language_dr ON publishers(language,ahrefs_dr); COMMIT;");
    if (JSON.stringify(facts(output)) !== JSON.stringify(expected)) {
      throw new Error("RESOURCE_LIBRARY_EXPORT_MISMATCH");
    }
    output.close();
    output = undefined;
    writeFileSync(manifestPath, `${JSON.stringify({
      formatVersion: 1,
      source: "publisher-catalog",
      ...expected,
      sha256: sha256(readFileSync(destination)),
      columns: names,
    }, null, 2)}\n`, { flag: "wx" });
    manifestCreated = true;
    return verifyBundle(directory);
  } catch (error) {
    output?.close();
    if (created) {
      for (const path of [destination, `${destination}-journal`, ...(manifestCreated ? [manifestPath] : [])]) {
        if (existsSync(path)) unlinkSync(path);
      }
    }
    throw error;
  } finally {
    source.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, directory] = process.argv.slice(2);
  try {
    const result = command === "check" && !directory
      ? verifyBundle(source ? resolve(source) : bundledDirectory)
      : command === "export" && source
        ? exportBundle(source, directory ? resolve(directory) : bundledDirectory)
        : (() => { throw new Error("Usage: resource-library-bundle.mjs check [directory] | export <source.sqlite> [new-directory]"); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RESOURCE_LIBRARY_BUNDLE_FAILED");
    process.exitCode = 1;
  }
}
