import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import {
  secretKinds,
} from "../src/modules/backlinks/ports/secret-store.port.js";
import {
  buildLocalProductDataForSeoEnvironment,
  localProductDataForSeoBootstrapInputSchema,
  updateLocalProductDataForSeoManifest,
} from "../src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.js";

type Options = Readonly<{
  manifestPath: string;
  runtimeRoot: string;
  secretRoot: string;
}>;

function readOptions(): Options {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  if (localAppData === undefined || userProfile === undefined) {
    throw new Error("LOCAL_PRODUCT_DATAFORSEO_IMPORT_PATHS_UNAVAILABLE");
  }
  const runtimeRoot = resolve(
    process.env.GROWTHOS_LOCAL_PRODUCT_RUNTIME_ROOT
      ?? resolve(localAppData, "GrowthOS", "live001"),
  );
  return {
    manifestPath: resolve(
      process.env.LIVE_AUTH_MANIFEST_PATH
        ?? resolve(
          userProfile,
          ".growthos",
          "live",
          "live-auth-manifest.json",
        ),
    ),
    runtimeRoot,
    secretRoot: resolve(runtimeRoot, "secrets"),
  };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 65_536) {
      throw new Error("LOCAL_PRODUCT_DATAFORSEO_IMPORT_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value === "") {
    throw new Error("LOCAL_PRODUCT_DATAFORSEO_IMPORT_STDIN_REQUIRED");
  }
  return value;
}

function parseEnvironmentFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("LOCAL_PRODUCT_DATAFORSEO_ENVIRONMENT_INVALID");
    }
    const name = line.slice(0, separator).trim();
    if (values.has(name)) {
      throw new Error(
        `LOCAL_PRODUCT_DATAFORSEO_ENVIRONMENT_DUPLICATE:${name}`,
      );
    }
    values.set(name, line.slice(separator + 1));
  }
  return values;
}

function serializeEnvironmentFile(values: ReadonlyMap<string, string>): string {
  return `${[...values.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function writeTextAtomically(path: string, value: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    value,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporaryPath, path);
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const options = readOptions();
  const input = localProductDataForSeoBootstrapInputSchema.parse(JSON.parse(
    await readStandardInput(),
  ) as unknown);
  const environmentUpdates =
    buildLocalProductDataForSeoEnvironment(input);
  const environmentPaths = [
    resolve(options.runtimeRoot, "backlinks-api.env"),
    resolve(options.runtimeRoot, "backlinks-worker.env"),
  ] as const;
  const [manifestText, ...environmentTexts] = await Promise.all([
    readOptionalText(options.manifestPath),
    ...environmentPaths.map((path) => readFile(path, "utf8")),
  ]);
  const manifest = manifestText === null
    ? null
    : updateLocalProductDataForSeoManifest(
      JSON.parse(manifestText) as unknown,
      input,
      new Date(),
    );
  const environments = environmentTexts.map(parseEnvironmentFile);
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environmentUpdates)) {
      environment.set(name, value);
    }
    environment.set("DATAFORSEO_ENABLED", "false");
  }

  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretRoot,
  });
  await secretStore.importFixed({
    reference: parseLocalProductSecretReference(
      input.credentialSecretRef,
      secretKinds.dataForSeoCredential,
    ),
    plaintext: JSON.stringify({
      login: input.login,
      password: input.password,
    }),
    context: {
      organizationId: "local-product",
      subjectProvider: "dataforseo",
    },
    replace: true,
  });
  const writes: Promise<void>[] = [
    ...environmentPaths.map((path, index) =>
      writeTextAtomically(
        path,
        serializeEnvironmentFile(environments[index] ?? new Map()),
      )),
  ];
  if (manifest !== null) {
    writes.push(writeTextAtomically(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    ));
  }
  await Promise.all(writes);

  console.log(JSON.stringify({
    imported: true,
    websiteProjectKey: input.websiteProjectKey,
    credentialSecretReference: input.credentialSecretRef,
    endpointAllowlist: input.endpointAllowlist,
    estimatedCostMicros: input.estimatedCostMicros,
    absoluteBudgetMicros: input.absoluteBudgetMicros,
    maxPaidCalls: input.maxPaidCalls,
    dataForSeoEnabled: false,
  }));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "LOCAL_PRODUCT_DATAFORSEO_IMPORT_FAILED",
  );
  process.exitCode = 1;
});
