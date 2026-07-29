import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adoptions = new Set([
  "direct-dependency", "adapter", "ported-source", "conditional", "rejected",
]);
const commitPattern = /^[a-f0-9]{40}$/i;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const floatingVersionPattern = /^(?:latest|\*)$|^[~^]/;
const requiredStrings = [
  "id", "project", "repository", "license", "adoption", "adr",
] as const;
type JsonObject = Record<string, unknown>;
type StringArrayField =
  | "sourceFiles" | "upstreamTests" | "targetFiles"
  | "allowedReuse" | "forbiddenReuse";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readStringArray(
  record: JsonObject,
  field: StringArrayField,
  path: string,
  errors: string[],
): string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    errors.push(`${path}.${field} must be an array of non-empty strings`);
    return [];
  }
  return value;
}

function validateRecord(
  value: unknown,
  index: number,
  seenIds: Set<string>,
  errors: string[],
): void {
  const path = `sources[${index}]`;
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  for (const field of requiredStrings) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${path}.${field} must be a non-empty string`);
    }
  }
  const sourceFiles = readStringArray(value, "sourceFiles", path, errors);
  const upstreamTests = readStringArray(value, "upstreamTests", path, errors);
  const targetFiles = readStringArray(value, "targetFiles", path, errors);
  readStringArray(value, "allowedReuse", path, errors);
  readStringArray(value, "forbiddenReuse", path, errors);

  if (isNonEmptyString(value.id)) {
    if (seenIds.has(value.id)) {
      errors.push(`${path}.id must be unique`);
    }
    seenIds.add(value.id);
  }
  if (isNonEmptyString(value.adoption) && !adoptions.has(value.adoption)) {
    errors.push(`${path}.adoption is not supported`);
  }

  const hasCommit = isNonEmptyString(value.auditedCommit);
  const hasIntegrity = isNonEmptyString(value.packageIntegrity);
  if (hasCommit === hasIntegrity) {
    errors.push(`${path} must define exactly one auditedCommit or packageIntegrity`);
  } else if (hasCommit && !commitPattern.test(value.auditedCommit)) {
    errors.push(`${path}.auditedCommit must be a full 40-character SHA`);
  } else if (hasIntegrity && !integrityPattern.test(value.packageIntegrity)) {
    errors.push(`${path}.packageIntegrity must be a sha512 integrity value`);
  }

  if (
    value.adoption === "direct-dependency" &&
    (!isNonEmptyString(value.packageVersion) ||
      floatingVersionPattern.test(value.packageVersion))
  ) {
    errors.push(`${path}.packageVersion must be an exact version`);
  }

  if (value.adoption === "ported-source") {
    if (!hasCommit) {
      errors.push(`${path}.auditedCommit is required for ported-source`);
    }
    for (const [field, files] of [
      ["sourceFiles", sourceFiles],
      ["upstreamTests", upstreamTests],
      ["targetFiles", targetFiles],
    ] as const) {
      if (files.length === 0) {
        errors.push(`${path}.${field} must not be empty for ported-source`);
      }
    }

    const hashes = value.sourceFileHashes;
    if (!isObject(hashes)) {
      errors.push(`${path}.sourceFileHashes is required for ported-source`);
    } else {
      for (const sourceFile of sourceFiles) {
        const hash = hashes[sourceFile];
        if (!isNonEmptyString(hash) || !sha256Pattern.test(hash)) {
          errors.push(`${path}.sourceFileHashes[${sourceFile}] must be a SHA-256 hash`);
        }
      }
    }
  }

  if (value.adoption === "conditional" && value.defaultEnabled !== false) {
    errors.push(`${path}.defaultEnabled must be false for conditional sources`);
  }
}

export function validateSourceManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ["manifest must be an object"];
  }
  if (value.schemaVersion !== "1.0") {
    errors.push('schemaVersion must equal "1.0"');
  }
  if (!Array.isArray(value.sources)) {
    errors.push("sources must be an array");
    return errors;
  }

  const seenIds = new Set<string>();
  value.sources.forEach((record, index) => {
    validateRecord(record, index, seenIds, errors);
  });
  return errors;
}

export async function checkSourceManifest(
  manifestPath = fileURLToPath(
    new URL("../src/modules/backlinks/third-party/source-manifest.json", import.meta.url),
  ),
): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const errors = validateSourceManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid source manifest:\n- ${errors.join("\n- ")}`);
  }
  const count = isObject(manifest) && Array.isArray(manifest.sources)
    ? manifest.sources.length
    : 0;
  console.log(`Source manifest valid: ${count} records`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  checkSourceManifest().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
