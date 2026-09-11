import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LocalProductBuildIdentity = Readonly<{
  schemaVersion: "growthos.local-product-build.v1";
  buildId: string;
  sourceFingerprint: string;
  artifactFingerprint: string;
  builtAt: string;
}>;

export type LocalProductBuildCheck = Readonly<{
  ok: boolean;
  code: "OK" | "LOCAL_PRODUCT_STALE_BUILD";
  identity?: LocalProductBuildIdentity;
  reasons: readonly string[];
}>;

const manifestFileName = "local-product-build-identity.json";
const sourceRootNames = ["src"];
const sourceFileNames = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/local-product-build-identity.ts",
  "resources/resource-library/bundled/manifest.json",
  "resources/resource-library/bundled/publishers.sqlite",
];

function listFiles(root: string, directory: string): string[] {
  const absoluteDirectory = resolve(root, directory);
  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? listFiles(root, relativePath)
        : [relativePath];
    });
}

function hashFiles(root: string, fileNames: readonly string[]): string {
  const hash = createHash("sha256");
  for (const fileName of [...fileNames].sort()) {
    const absolutePath = resolve(root, fileName);
    hash.update(relative(root, absolutePath).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sourceFiles(root: string): string[] {
  return [
    ...sourceFileNames,
    ...sourceRootNames.flatMap((directory) => listFiles(root, directory)),
  ];
}

function artifactFiles(root: string): string[] {
  return listFiles(root, "dist")
    .filter((fileName) => fileName.endsWith(".js"));
}

function manifestPath(root: string): string {
  return resolve(root, "dist", manifestFileName);
}

export function calculateLocalProductSourceFingerprint(
  root: string,
): string {
  return hashFiles(root, sourceFiles(root));
}

export function calculateLocalProductArtifactFingerprint(
  root: string,
): string {
  return hashFiles(root, artifactFiles(root));
}

export function writeLocalProductBuildIdentity(
  root: string,
  builtAt = new Date().toISOString(),
): LocalProductBuildIdentity {
  const sourceFingerprint = calculateLocalProductSourceFingerprint(root);
  const identity: LocalProductBuildIdentity = {
    schemaVersion: "growthos.local-product-build.v1",
    buildId: `local-product-${sourceFingerprint.slice(0, 24)}`,
    sourceFingerprint,
    artifactFingerprint:
      calculateLocalProductArtifactFingerprint(root),
    builtAt,
  };
  writeFileSync(
    manifestPath(root),
    `${JSON.stringify(identity, null, 2)}\n`,
    "utf8",
  );
  return identity;
}

export function checkLocalProductBuildIdentity(
  root: string,
): LocalProductBuildCheck {
  const reasons: string[] = [];
  let identity: LocalProductBuildIdentity | undefined;
  try {
    identity = JSON.parse(
      readFileSync(manifestPath(root), "utf8"),
    ) as LocalProductBuildIdentity;
  } catch {
    reasons.push("BUILD_IDENTITY_MISSING_OR_INVALID");
  }
  if (identity !== undefined) {
    if (
      identity.sourceFingerprint
      !== calculateLocalProductSourceFingerprint(root)
    ) {
      reasons.push("SOURCE_FINGERPRINT_MISMATCH");
    }
    if (
      identity.artifactFingerprint
      !== calculateLocalProductArtifactFingerprint(root)
    ) {
      reasons.push("ARTIFACT_FINGERPRINT_MISMATCH");
    }
  }
  return reasons.length === 0 && identity !== undefined
    ? { ok: true, code: "OK", identity, reasons }
    : { ok: false, code: "LOCAL_PRODUCT_STALE_BUILD", reasons };
}

function runCli(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const command = process.argv[2];
  if (command === "write") {
    console.log(JSON.stringify(writeLocalProductBuildIdentity(root)));
    return;
  }
  if (command === "check") {
    const result = checkLocalProductBuildIdentity(root);
    console.log(JSON.stringify(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  console.error(
    "Usage: tsx scripts/local-product-build-identity.ts <write|check>",
  );
  process.exitCode = 2;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url))
) {
  runCli();
}
