import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const productionAllowlist: Readonly<Record<string, string>> = {
  "@ai-sdk/openai": "4.0.15",
  "@fastify/swagger": "9.8.1",
  "@googleapis/gmail": "17.0.0",
  "@openfeature/server-sdk": "1.22.0",
  "@opentelemetry/api": "1.9.1",
  "@temporalio/activity": "1.20.2",
  "@temporalio/client": "1.20.2",
  "@temporalio/common": "1.20.2",
  "@temporalio/worker": "1.20.2",
  "@temporalio/workflow": "1.20.2",
  ai: "7.0.29",
  cheerio: "1.1.2",
  "dataforseo-client": "2.0.25",
  "drizzle-orm": "0.45.2",
  exceljs: "4.4.0",
  fastify: "5.10.0",
  "fastify-type-provider-zod": "7.0.0",
  "google-auth-library": "10.9.1",
  "isomorphic-dompurify": "3.18.0",
  jsdom: "29.1.1",
  nodemailer: "9.0.3",
  pg: "8.22.0",
  "postal-mime": "2.7.5",
  "robots-parser": "3.0.1",
  "simple-statistics": "7.9.3",
  tldts: "7.4.9",
  undici: "7.28.0",
  validator: "13.15.35",
  zod: "4.4.3",
};
const developmentAllowlist: Readonly<Record<string, string>> = {
  "@playwright/test": "1.61.1",
  "@temporalio/testing": "1.20.2",
  "@types/node": "24.13.3",
  "drizzle-kit": "0.31.10",
  eslint: "10.7.0",
  msw: "2.15.0",
  playwright: "1.61.1",
  testcontainers: "12.0.4",
  tsx: "4.20.6",
  typescript: "5.9.3",
  "typescript-eslint": "8.65.0",
  vitest: "4.1.10",
};
const rejectedDependencies = new Set(["bullmq", "graphile-worker", "n8n", "pg-boss"]);
const floatingVersionPattern = /^(?:latest|\*)$|^[~^]|^(?:file|git|github|http|workspace):/;
type JsonObject = Record<string, unknown>;
type DependencyMap = Record<string, string>;
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRejected(name: string): boolean {
  return rejectedDependencies.has(name) || name.startsWith("@n8n/");
}
function readDependencyMap(value: unknown, path: string, errors: string[]): DependencyMap {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  const dependencies: DependencyMap = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string" || version.length === 0) {
      errors.push(`${path}.${name} must be a non-empty version string`);
    } else {
      dependencies[name] = version;
    }
  }
  return dependencies;
}
function validateDeclared(
  dependencies: DependencyMap,
  allowlist: Readonly<Record<string, string>>,
  path: string,
  errors: string[],
): void {
  for (const [name, version] of Object.entries(dependencies)) {
    if (isRejected(name)) {
      errors.push(`${path}.${name} is explicitly rejected`);
      continue;
    }
    const approvedVersion = allowlist[name];
    if (approvedVersion === undefined) {
      errors.push(`${path}.${name} is not approved`);
    } else if (floatingVersionPattern.test(version)) {
      errors.push(`${path}.${name} must not use floating version ${version}`);
    } else if (version !== approvedVersion) {
      errors.push(`${path}.${name} must equal approved version ${approvedVersion}`);
    }
  }
}
function compareDependencyMaps(
  declared: DependencyMap,
  locked: DependencyMap,
  path: string,
  errors: string[],
): void {
  for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
    if (declared[name] !== locked[name]) {
      errors.push(`${path}.${name} must match package.json`);
    }
  }
}
export function validateDependencyAllowlist(
  packageJson: unknown,
  packageLock: unknown,
): string[] {
  const errors: string[] = [];
  if (!isObject(packageJson) || !isObject(packageLock)) {
    return ["package.json and package-lock.json must be objects"];
  }
  const dependencies = readDependencyMap(
    packageJson.dependencies, "dependencies", errors,
  );
  const devDependencies = readDependencyMap(
    packageJson.devDependencies, "devDependencies", errors,
  );
  validateDeclared(dependencies, productionAllowlist, "dependencies", errors);
  validateDeclared(
    devDependencies, developmentAllowlist, "devDependencies", errors,
  );
  if (!isObject(packageLock.packages)) {
    errors.push("package-lock.json packages must be an object");
    return errors;
  }
  const packages = packageLock.packages;
  const root = packages[""];
  if (!isObject(root)) {
    errors.push('package-lock.json packages[""] must be an object');
    return errors;
  }
  const lockedDependencies = readDependencyMap(
    root.dependencies, 'package-lock.json packages[""].dependencies', errors,
  );
  const lockedDevDependencies = readDependencyMap(
    root.devDependencies, 'package-lock.json packages[""].devDependencies', errors,
  );
  compareDependencyMaps(
    dependencies, lockedDependencies, "package-lock dependencies", errors,
  );
  compareDependencyMaps(
    devDependencies, lockedDevDependencies, "package-lock devDependencies", errors,
  );
  for (const [name, version] of Object.entries({
    ...dependencies, ...devDependencies,
  })) {
    const installed = packages[`node_modules/${name}`];
    if (!isObject(installed) || installed.version !== version) {
      errors.push(`package-lock node_modules/${name} must resolve version ${version}`);
    }
  }
  for (const lockPath of Object.keys(packages)) {
    const marker = "node_modules/";
    const markerIndex = lockPath.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const name = lockPath.slice(markerIndex + marker.length);
      if (isRejected(name)) {
        errors.push(`package-lock dependency tree contains rejected ${name}`);
      }
    }
  }
  return errors;
}
export async function checkDependencyAllowlist(
  packagePath = fileURLToPath(new URL("../package.json", import.meta.url)),
  lockPath = fileURLToPath(new URL("../package-lock.json", import.meta.url)),
): Promise<void> {
  const [packageContents, lockContents] = await Promise.all([
    readFile(packagePath, "utf8"), readFile(lockPath, "utf8"),
  ]);
  const errors = validateDependencyAllowlist(
    JSON.parse(packageContents), JSON.parse(lockContents),
  );
  if (errors.length > 0) {
    throw new Error(`Invalid dependency allowlist:\n- ${errors.join("\n- ")}`);
  }
  console.log("Dependency allowlist valid");
}
const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  checkDependencyAllowlist().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
