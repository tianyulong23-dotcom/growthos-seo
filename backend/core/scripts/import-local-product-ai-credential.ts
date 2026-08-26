import {
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";

import {
  localProductAiProviderCredentialReference,
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import {
  secretKinds,
} from "../src/modules/backlinks/ports/secret-store.port.js";
import {
  buildLocalProductAiEnvironment,
  calculateMaximumReservationUsd,
  localProductAiDiscoveryModelId,
  localProductAiBootstrapInputSchema,
  updateLocalProductAiManifest,
} from "../src/modules/backlinks/runtime/local-product-ai-bootstrap.js";

type Options = Readonly<{
  manifestPath: string;
  runtimeRoot: string;
  secretRoot: string;
}>;

function readOptions(): Options {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  if (localAppData === undefined || userProfile === undefined) {
    throw new Error("LOCAL_PRODUCT_AI_IMPORT_PATHS_UNAVAILABLE");
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
      throw new Error("LOCAL_PRODUCT_AI_IMPORT_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value === "") {
    throw new Error("LOCAL_PRODUCT_AI_IMPORT_STDIN_REQUIRED");
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
      throw new Error("LOCAL_PRODUCT_AI_ENVIRONMENT_INVALID");
    }
    const name = line.slice(0, separator).trim();
    if (values.has(name)) {
      throw new Error(`LOCAL_PRODUCT_AI_ENVIRONMENT_DUPLICATE:${name}`);
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

async function main(): Promise<void> {
  const options = readOptions();
  const input = localProductAiBootstrapInputSchema.parse(JSON.parse(
    await readStandardInput(),
  ) as unknown);
  const environmentUpdates = buildLocalProductAiEnvironment(input);
  const environmentPaths = [
    resolve(options.runtimeRoot, "backlinks-api.env"),
    resolve(options.runtimeRoot, "backlinks-worker.env"),
  ] as const;
  const [manifestText, ...environmentTexts] = await Promise.all([
    readFile(options.manifestPath, "utf8"),
    ...environmentPaths.map((path) => readFile(path, "utf8")),
  ]);
  const manifest = updateLocalProductAiManifest(
    JSON.parse(manifestText) as unknown,
    input,
  );
  const environments = environmentTexts.map(parseEnvironmentFile);
  const enabledStates: boolean[] = [];
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environmentUpdates)) {
      environment.set(name, value);
    }
    const enabled = environment.get("AI_PROVIDER_ENABLED");
    if (enabled === undefined) {
      environment.set("AI_PROVIDER_ENABLED", "false");
      enabledStates.push(false);
    } else if (enabled === "true") {
      enabledStates.push(true);
    } else if (enabled === "false") {
      enabledStates.push(false);
    } else {
      throw new Error("LOCAL_PRODUCT_AI_PROVIDER_ENABLED_INVALID");
    }
  }

  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretRoot,
  });
  await secretStore.importFixed({
    reference: parseLocalProductSecretReference(
      localProductAiProviderCredentialReference,
      secretKinds.aiProviderCredential,
    ),
    plaintext: input.apiKey,
    context: {
      organizationId: "local-product",
      subjectProvider: "ai",
    },
    replace: true,
  });
  await Promise.all([
    writeTextAtomically(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    ...environmentPaths.map((path, index) =>
      writeTextAtomically(
        path,
        serializeEnvironmentFile(environments[index] ?? new Map()),
      )),
  ]);

  console.log(JSON.stringify({
    imported: true,
    providerRef: input.providerRef,
    providerBaseUrl: input.baseUrl,
    modelId: input.modelId,
    discoveryModelId:
      input.discoveryModelId ?? localProductAiDiscoveryModelId,
    credentialSecretReference:
      localProductAiProviderCredentialReference,
    maxCalls: input.maxCalls,
    maximumReservationUsd: calculateMaximumReservationUsd(input),
    aiProviderEnabled: enabledStates.every(Boolean),
  }));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "LOCAL_PRODUCT_AI_IMPORT_FAILED",
  );
  process.exitCode = 1;
});
