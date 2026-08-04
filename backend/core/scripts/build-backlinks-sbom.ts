import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type DependencyMap = Record<string, string>;
export interface BuildProvenance {
  node: string;
  npm: string;
  os: string;
  cpuArchitecture: string;
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseObject(contents: string, name: string): JsonObject {
  const value: unknown = JSON.parse(contents);
  if (!isObject(value)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value;
}
function readDependencies(value: unknown, path: string): DependencyMap {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  const dependencies: DependencyMap = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`${path}.${name} must have an exact version`);
    }
    dependencies[name] = version;
  }
  return dependencies;
}
function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
function packageName(lockPath: string): string | undefined {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  return index < 0 ? undefined : lockPath.slice(index + marker.length);
}
function packageUrl(name: string, version: string): string {
  const parts = name.split("/");
  const encoded = parts.length === 2
    ? `${encodeURIComponent(parts[0] ?? "")}/${encodeURIComponent(parts[1] ?? "")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}
function buildComponents(packages: JsonObject): JsonObject[] {
  const components = new Map<string, JsonObject>();
  for (const [lockPath, value] of Object.entries(packages)) {
    const name = packageName(lockPath);
    if (name === undefined || !isObject(value)) {
      continue;
    }
    if (typeof value.version !== "string" || value.version.length === 0) {
      throw new Error(`package-lock ${lockPath} must have an exact version`);
    }
    const purl = packageUrl(name, value.version);
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name,
      version: value.version,
      purl,
    });
  }
  return [...components.values()].sort((left, right) =>
    String(left["bom-ref"]).localeCompare(String(right["bom-ref"])),
  );
}
const sensitiveKey = /^(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|client[-_]?secret|private[-_]?key|refresh[-_]?token)$/i;
const sensitiveValue = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}\b/i,
  /\b(?:github_pat_|gh[pousr]_|npm_)[A-Za-z0-9_]{16,}\b/,
];
export function scanSensitiveFields(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanSensitiveFields(entry, `${path}[${index}]`));
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      sensitiveKey.test(key)
        ? [`${path}.${key} is a sensitive field`]
        : scanSensitiveFields(entry, `${path}.${key}`),
    );
  }
  return typeof value === "string"
    && sensitiveValue.some((pattern) => pattern.test(value))
    ? [`${path} contains a credential-shaped value`]
    : [];
}
export function buildBacklinksSbom(
  packageContents: string,
  lockContents: string,
  sourceManifestContents: string,
  provenance: BuildProvenance,
): JsonObject {
  const packageJson = parseObject(packageContents, "package.json");
  const packageLock = parseObject(lockContents, "package-lock.json");
  parseObject(sourceManifestContents, "source-manifest.json");
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error("package.json must have name and version");
  }
  if (!isObject(packageLock.packages)) {
    throw new Error("package-lock.json packages must be an object");
  }
  const directDependencies = {
    ...readDependencies(packageJson.dependencies, "dependencies"),
    ...readDependencies(packageJson.devDependencies, "devDependencies"),
  };
  const components = buildComponents(packageLock.packages);
  const versions = new Set(components.map((component) =>
    `${String(component.name)}@${String(component.version)}`,
  ));
  for (const [name, version] of Object.entries(directDependencies)) {
    if (!versions.has(`${name}@${version}`)) {
      throw new Error(`SBOM component ${name} must resolve exact version ${version}`);
    }
  }
  const rootPurl = packageUrl(packageJson.name, packageJson.version);
  const bom: JsonObject = {
    "$schema": "https://cyclonedx.org/schema/bom-1.7.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: {
      tools: {
        components: [{
          type: "application",
          name: "build-backlinks-sbom",
          version: packageJson.version,
        }],
      },
      component: {
        type: "application",
        "bom-ref": rootPurl,
        name: packageJson.name,
        version: packageJson.version,
        purl: rootPurl,
      },
      properties: [
        { name: "growthos:provenance:node", value: provenance.node },
        { name: "growthos:provenance:npm", value: provenance.npm },
        { name: "growthos:provenance:os", value: provenance.os },
        { name: "growthos:provenance:cpu-architecture", value: provenance.cpuArchitecture },
        { name: "growthos:provenance:package-lock-sha256", value: sha256(lockContents) },
        { name: "growthos:provenance:source-manifest-sha256", value: sha256(sourceManifestContents) },
      ],
    },
    components,
  };
  const sensitiveFields = scanSensitiveFields(bom);
  if (sensitiveFields.length > 0) {
    throw new Error(`SBOM contains sensitive data:\n- ${sensitiveFields.join("\n- ")}`);
  }
  return bom;
}
export async function writeBacklinksSbom(): Promise<string> {
  const base = new URL("../", import.meta.url);
  const [packageContents, lockContents, sourceManifestContents] = await Promise.all([
    readFile(new URL("package.json", base), "utf8"),
    readFile(new URL("package-lock.json", base), "utf8"),
    readFile(new URL("src/modules/backlinks/third-party/source-manifest.json", base), "utf8"),
  ]);
  const packageJson = parseObject(packageContents, "package.json");
  const npm = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.replace(/^npm@/, "")
    : "unknown";
  const bom = buildBacklinksSbom(packageContents, lockContents, sourceManifestContents, {
    node: process.version,
    npm,
    os: platform(),
    cpuArchitecture: process.arch,
  });
  const outputPath = fileURLToPath(
    new URL(`artifacts/sbom/backlinks-core-${String(packageJson.version)}.cdx.json`, base),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bom)}\n`, "utf8");
  const components = Array.isArray(bom.components) ? bom.components.length : 0;
  console.log(
    `CycloneDX SBOM written with ${components} exact components and 0 sensitive fields: ${outputPath}`,
  );
  return outputPath;
}
const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  writeBacklinksSbom().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
