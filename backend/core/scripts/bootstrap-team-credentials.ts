import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LocalProductSecretStoreClient,
  googleOauthClientSecretReference,
  localProductAhrefsCredentialReference,
  localProductAiProviderCredentialReference,
  localProductDataForSeoCredentialReference,
  parseLocalProductSecretReference,
} from "../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../src/modules/backlinks/ports/secret-store.port.js";
import { buildLocalProductAiEnvironment, localProductAiBootstrapInputSchema } from "../src/modules/backlinks/runtime/local-product-ai-bootstrap.js";

const secret = z.string().trim().min(1).max(4096);
const inputSchema = z.object({
  ahrefs: z.object({ apiKey: secret }).strict(),
  dataforseo: z.object({ login: secret, password: z.string().min(1).max(4096) }).strict(),
  google: z.object({ clientSecret: secret }).strict(),
  ai: localProductAiBootstrapInputSchema,
}).strict();

export async function bootstrapTeamCredentials(root: string, value: unknown) {
  const input = inputSchema.parse(value);
  if (!isAbsolute(root)) throw new Error("TEAM_SECRET_ROOT_MUST_BE_ABSOLUTE");
  const environmentPath = join(dirname(root), "backlinks-worker.env");
  if (existsSync(environmentPath)) throw new Error("TEAM_CONFIGURATION_ALREADY_EXISTS");
  const environment = buildLocalProductAiEnvironment(input.ai);
  // This is first-install only: never overwrite a colleague's existing credentials.
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  const store = new LocalProductSecretStoreClient({ rootDirectory: root });
  const credentials = [
    { reference: localProductAhrefsCredentialReference, kind: secretKinds.ahrefsCredential,
      provider: "ahrefs", plaintext: JSON.stringify(input.ahrefs) },
    { reference: localProductDataForSeoCredentialReference, kind: secretKinds.dataForSeoCredential,
      provider: "dataforseo", plaintext: JSON.stringify(input.dataforseo) },
    { reference: googleOauthClientSecretReference, kind: secretKinds.googleOauthClientSecret,
      provider: "google", plaintext: input.google.clientSecret },
    { reference: localProductAiProviderCredentialReference, kind: secretKinds.aiProviderCredential,
      provider: "ai", plaintext: input.ai.apiKey },
  ];
  for (const credential of credentials) {
    await store.importFixed({
      reference: parseLocalProductSecretReference(credential.reference, credential.kind),
      plaintext: credential.plaintext,
      context: { organizationId: "local-product", subjectProvider: credential.provider },
    });
  }
  await writeFile(environmentPath, Object.entries(environment).map(([key, item]) => `${key}=${item}\n`).join(""),
    { flag: "wx", mode: 0o600 });
}

async function main() {
  const root = process.env.PLATFORM_SECRET_STORE_ROOT;
  if (!root) throw new Error("TEAM_SECRET_ROOT_REQUIRED");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 65_536) throw new Error("TEAM_CREDENTIAL_INPUT_TOO_LARGE");
    chunks.push(bytes);
  }
  await bootstrapTeamCredentials(root, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  console.log("Team credentials initialized. No provider requests, mailbox authorization, or sends performed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("TEAM_CREDENTIAL_BOOTSTRAP_FAILED: check input and use a fresh absolute secret-store directory.");
    process.exitCode = 1;
  });
}
