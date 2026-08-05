import {
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  googleOauthClientSecretReference,
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../src/modules/backlinks/ports/secret-store.port.js";
import {
  buildLocalProductGoogleRedirectUri,
  maskGoogleIdentifier,
  parseGoogleWebOAuthCredentials,
  updateLocalProductOauthManifest,
} from "../src/modules/backlinks/runtime/local-product-oauth-bootstrap.js";

type Options = Readonly<{
  credentialsPath: string;
  manifestPath: string;
  secretRoot: string;
  maxSendCalls: number;
}>;

const readOption = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function readOptions(): Options {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const credentialsPath = readOption("--credentials");
  if (
    credentialsPath === undefined
    || localAppData === undefined
    || userProfile === undefined
  ) {
    throw new Error("GOOGLE_OAUTH_IMPORT_ARGUMENTS_REQUIRED");
  }
  const manifestPath = readOption("--manifest")
    ?? resolve(userProfile, ".growthos", "live", "live-auth-manifest.json");
  const secretRoot = readOption("--secret-root")
    ?? resolve(localAppData, "GrowthOS", "live001", "secrets");
  return {
    credentialsPath: resolve(credentialsPath),
    manifestPath: resolve(manifestPath),
    secretRoot: resolve(secretRoot),
    maxSendCalls: Number(readOption("--max-send-calls") ?? "20"),
  };
}

function assertCredentialFileOutsideRepository(credentialsPath: string): void {
  const repositoryRoot = resolve(fileURLToPath(
    new URL("../../../", import.meta.url),
  ));
  const pathFromRepository = relative(repositoryRoot, credentialsPath);
  if (
    pathFromRepository === ""
    || (
      !pathFromRepository.startsWith(`..${sep}`)
      && pathFromRepository !== ".."
      && !isAbsolute(pathFromRepository)
    )
  ) {
    throw new Error("GOOGLE_OAUTH_CREDENTIAL_FILE_MUST_BE_OUTSIDE_REPOSITORY");
  }
}

async function writeJsonAtomically(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const options = readOptions();
  assertCredentialFileOutsideRepository(options.credentialsPath);
  const [credentialText, manifestText] = await Promise.all([
    readFile(options.credentialsPath, "utf8"),
    readFile(options.manifestPath, "utf8"),
  ]);
  const currentManifest = JSON.parse(manifestText) as {
    runtime?: { websiteProjectKey?: unknown };
  };
  const websiteProjectKey = currentManifest.runtime?.websiteProjectKey;
  if (typeof websiteProjectKey !== "string") {
    throw new Error("LOCAL_PRODUCT_PROJECT_KEY_REQUIRED");
  }
  const redirectUri = buildLocalProductGoogleRedirectUri(websiteProjectKey);
  const credentials = parseGoogleWebOAuthCredentials(
    JSON.parse(credentialText) as unknown,
    redirectUri,
  );
  const manifest = updateLocalProductOauthManifest(
    currentManifest,
    {
      clientId: credentials.clientId,
      projectId: credentials.projectId,
      websiteProjectKey,
      maxSendCalls: options.maxSendCalls,
    },
  );
  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretRoot,
  });
  const reference = parseLocalProductSecretReference(
    googleOauthClientSecretReference,
    secretKinds.googleOauthClientSecret,
  );
  await secretStore.importFixed({
    reference,
    plaintext: credentials.clientSecret,
    context: {
      organizationId: "local-product",
      subjectProvider: "google",
    },
    replace: true,
  });
  await writeJsonAtomically(options.manifestPath, manifest);
  await rm(options.credentialsPath, { force: true });

  console.log(JSON.stringify({
    imported: true,
    credentialFileDeleted: true,
    clientIdMasked: maskGoogleIdentifier(credentials.clientId),
    cloudProjectIdMasked: maskGoogleIdentifier(credentials.projectId),
    clientSecretReference: googleOauthClientSecretReference,
    redirectUri,
    maxSendCalls: options.maxSendCalls,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "GOOGLE_OAUTH_IMPORT_FAILED");
  process.exitCode = 1;
});
