import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const approvedDirectLicenses: Readonly<Record<string, string>> = {
  "@ai-sdk/openai": "Apache-2.0",
  "@fastify/swagger": "MIT",
  "@googleapis/gmail": "Apache-2.0",
  "@opentelemetry/api": "Apache-2.0",
  "@temporalio/client": "MIT",
  "@temporalio/worker": "MIT",
  "@types/node": "MIT",
  eslint: "MIT",
  ai: "Apache-2.0",
  "dataforseo-client": "ISC",
  "drizzle-orm": "Apache-2.0",
  cheerio: "MIT",
  fastify: "MIT",
  "fastify-type-provider-zod": "MIT",
  "google-auth-library": "Apache-2.0",
  "isomorphic-dompurify": "MIT",
  jsdom: "MIT",
  msw: "MIT",
  nodemailer: "MIT-0",
  pg: "MIT",
  "postal-mime": "MIT-0",
  tsx: "MIT",
  "robots-parser": "MIT",
  "simple-statistics": "ISC",
  testcontainers: "MIT",
  tldts: "MIT",
  typescript: "Apache-2.0",
  "typescript-eslint": "MIT",
  undici: "MIT",
  validator: "MIT",
  vitest: "MIT",
  zod: "MIT",
};
const approvedSourceLicenses: Readonly<Record<string, string>> = {
  "OSS-GOOGLE-01": "Apache-2.0",
  "OSS-GOOGLE-02": "Apache-2.0",
  "OSS-INF-01": "MIT",
  "OSS-INF-01A": "MIT",
  "OSS-INF-02": "MIT",
  "OSS-INF-02A": "MIT",
  "OSS-INF-03": "Apache-2.0",
  "OSS-INF-04": "MIT",
  "OSS-MAIL-01": "MIT-0",
  "OSS-MAIL-02": "MIT-0",
  "OSS-MAIL-03": "MIT",
  "OSS-MAIL-04": "MIT",
  "OSS-RUNTIME-01": "MIT",
  "OSS-RUNTIME-02": "Artistic-2.0",
  "OSS-HTML-01": "MIT",
  "OSS-HTML-02": "MIT",
  "OSS-HTML-03": "MIT",
  "OSS-PLC-01": "MIT",
  "OSS-PLC-02": "MIT",
  "OSS-REC-01": "MIT",
  "OSS-SEO-02": "MIT",
  "OSS-SEO-03": "ISC",
  "OSS-TEST-03": "MIT",
  "OSS-TOOL-01": "Apache-2.0",
  "OSS-TOOL-02": "MIT",
  "OSS-TOOL-03": "MIT",
  "OSS-TOOL-04": "MIT",
  "OSS-TOOL-05": "MIT",
};
const compatibleLicenses = new Set([
  "(AFL-2.1 OR BSD-3-Clause)",
  "(MIT OR CC0-1.0)",
  "(MPL-2.0 OR Apache-2.0)",
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND MIT",
  "BSD",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "PostgreSQL",
  "Unlicense",
]);
const lockLicenseOverrides: Readonly<Record<string, string>> = {
  "node_modules/buildcheck": "MIT",
  "node_modules/cpu-features": "MIT",
  "node_modules/ssh2": "MIT",
  "node_modules/unionfs": "Unlicense",
};
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function cell(value: string): string {
  return value.replaceAll("|", "\\|");
}

export function analyzeThirdPartyLicenses(
  packageJson: unknown,
  packageLock: unknown,
  sourceManifest: unknown,
): { errors: string[]; notice: string } {
  const errors: string[] = [];
  if (
    !isObject(packageJson) ||
    !isObject(packageLock) ||
    !isObject(sourceManifest)
  ) {
    return {
      errors: ["package, lockfile, and source manifest must be objects"],
      notice: "",
    };
  }
  if (!isObject(packageLock.packages)) {
    return {
      errors: ["package-lock.json packages must be an object"],
      notice: "",
    };
  }

  const inventory: string[] = [];
  const licenseSet = new Set<string>();
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (path === "" || (isObject(entry) && entry.link === true)) continue;
    if (!isObject(entry)) {
      errors.push(`package-lock ${path} must be an object`);
      continue;
    }
    const { version } = entry;
    const license = isText(entry.license)
      ? entry.license
      : lockLicenseOverrides[path];
    if (!isText(version)) errors.push(`package-lock ${path} has no version`);
    if (!isText(license)) {
      errors.push(`package-lock ${path} has no license`);
    } else if (!compatibleLicenses.has(license)) {
      errors.push(
        `package-lock ${path} uses incompatible or unapproved license ${license}`,
      );
    }
    if (isText(version) && isText(license)) {
      inventory.push(`${path}\t${version}\t${license}`);
      licenseSet.add(license);
    }
  }

  const directRows: string[] = [];
  for (const [field, scope] of [
    ["dependencies", "production"],
    ["devDependencies", "development"],
  ] as const) {
    const declared = packageJson[field];
    if (!isObject(declared)) continue;
    for (const [name, version] of Object.entries(declared)) {
      const expected = approvedDirectLicenses[name];
      const installed = packageLock.packages[`node_modules/${name}`];
      const license = isObject(installed) ? installed.license : undefined;
      if (expected === undefined) {
        errors.push(`${field}.${name} has no approved license baseline`);
      } else if (license !== expected) {
        errors.push(`${field}.${name} license must equal ${expected}`);
      }
      if (isText(version) && isText(license)) {
        directRows.push(`| \`${name}\` | ${scope} | ${version} | ${license} |`);
      }
    }
  }

  const runtimeRows: string[] = [];
  const sourceRows: string[] = [];
  if (!Array.isArray(sourceManifest.sources)) {
    errors.push("source manifest sources must be an array");
  } else {
    for (const [index, source] of sourceManifest.sources.entries()) {
      if (!isObject(source) || !isText(source.id) || !isText(source.license)) {
        errors.push(`source manifest sources[${index}] has no id or license`);
        continue;
      }
      const expected = approvedSourceLicenses[source.id];
      if (expected === undefined) {
        errors.push(
          `source manifest ${source.id} has no approved license baseline`,
        );
      } else if (source.license !== expected) {
        errors.push(
          `source manifest ${source.id} license must equal ${expected}`,
        );
      }
      if (!compatibleLicenses.has(source.license)) {
        errors.push(
          `source manifest ${source.id} uses incompatible license ${source.license}`,
        );
      }
      if (source.id.startsWith("OSS-RUNTIME-")) {
        const values = [
          source.project,
          source.packageVersion,
          source.repository,
        ];
        if (!values.every(isText)) {
          errors.push(
            `source manifest ${source.id} has incomplete runtime notice fields`,
          );
        } else {
          runtimeRows.push(
            `| ${cell(values[0])} | ${cell(values[1])} | ${cell(source.license)} | ${cell(values[2])} |`,
          );
        }
      }
      if (
        isObject(source.sourceFileHashes) &&
        Object.keys(source.sourceFileHashes).length > 0
      ) {
        const values = [
          source.id,
          source.project,
          source.auditedCommit,
          source.repository,
        ];
        if (!values.every(isText)) {
          errors.push(
            `source manifest ${source.id} has incomplete source notice fields`,
          );
        } else {
          sourceRows.push(
            `| ${cell(values[0])} | ${cell(values[1])} | \`${cell(values[2])}\` | ${cell(source.license)} | ${Object.keys(source.sourceFileHashes).length} | ${cell(values[3])} |`,
          );
        }
      }
    }
  }

  inventory.sort();
  const fingerprint = createHash("sha256")
    .update(inventory.join("\n"))
    .digest("hex");
  const notice = [
    "# Third-Party Notices",
    "",
    "Generated by `npm run licenses:check -- --write`. Do not edit manually.",
    "",
    "## Runtime Tooling",
    "",
    "<!-- prettier-ignore -->",
    "| Component | Version | License | Repository |",
    "|---|---:|---|---|",
    ...runtimeRows.sort(),
    "",
    "## Registered Source Provenance",
    "",
    "<!-- prettier-ignore -->",
    "| ID | Component | Audited commit | License | Files | Repository |",
    "|---|---|---|---|---:|---|",
    ...sourceRows.sort(),
    "",
    "- Per-file SHA-256 values are authoritative in `source-manifest.json`.",
    "- Registration does not assert that upstream application or business-model code has been copied.",
    "",
    "## Direct NPM Packages",
    "",
    "<!-- prettier-ignore -->",
    "| Package | Scope | Version | License |",
    "|---|---|---:|---|",
    ...directRows.sort(),
    "",
    "## Locked Dependency Inventory",
    "",
    `- Locked package entries: ${inventory.length}`,
    `- Licenses: ${[...licenseSet].sort().join(", ")}`,
    `- Inventory SHA-256: \`${fingerprint}\``,
    "- Exact package paths, integrity values, and resolved artifacts remain authoritative in `package-lock.json`.",
    "",
  ].join("\n");
  return { errors, notice };
}

export async function checkThirdPartyLicenses(
  writeNotice = false,
): Promise<void> {
  const base = new URL("../", import.meta.url);
  const path = (value: string) => fileURLToPath(new URL(value, base));
  const paths = {
    package: path("package.json"),
    lock: path("package-lock.json"),
    manifest: path("src/modules/backlinks/third-party/source-manifest.json"),
    notice: path("src/modules/backlinks/third-party/THIRD_PARTY_NOTICES.md"),
  };
  const [packageText, lockText, manifestText] = await Promise.all([
    readFile(paths.package, "utf8"),
    readFile(paths.lock, "utf8"),
    readFile(paths.manifest, "utf8"),
  ]);
  const result = analyzeThirdPartyLicenses(
    JSON.parse(packageText),
    JSON.parse(lockText),
    JSON.parse(manifestText),
  );
  if (result.errors.length > 0) {
    throw new Error(
      `Invalid third-party licenses:\n- ${result.errors.join("\n- ")}`,
    );
  }
  if (writeNotice) {
    await writeFile(paths.notice, result.notice, "utf8");
  } else if (
    (await readFile(paths.notice, "utf8")).replaceAll("\r\n", "\n") !==
    result.notice
  ) {
    throw new Error(
      "THIRD_PARTY_NOTICES.md is stale; run npm run licenses:check -- --write",
    );
  }
  const count =
    result.notice.match(/Locked package entries: (\d+)/)?.[1] ?? "0";
  console.log(`Third-party licenses valid: ${count} packages`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entrypoint)
) {
  checkThirdPartyLicenses(process.argv.includes("--write")).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
