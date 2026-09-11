import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapTeamCredentials } from "../../scripts/bootstrap-team-credentials.js";
import { LocalProductSecretStoreClient, localProductAhrefsCredentialReference,
  localProductAiProviderCredentialReference, localProductDataForSeoCredentialReference,
  googleOauthClientSecretReference, parseLocalProductSecretReference,
} from "../../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../../src/modules/backlinks/ports/secret-store.port.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const input = {
  ahrefs: { apiKey: "ahrefs-private-sentinel" },
  dataforseo: { login: "fixture-login", password: "dfs-private-sentinel" },
  google: { clientSecret: "google-private-sentinel" },
  ai: {
    apiKey: "ai-private-sentinel", providerRef: "openai", baseUrl: "https://api.openai.com/v1",
    modelId: "fixture-model", modelVersion: "fixture-v1", maxCalls: 1, timeoutMs: 10000,
    maxInputTokens: 100, maxOutputTokens: 100, absoluteBudgetUsd: 0.1,
    inputCostUsdPerMillionTokens: 1, outputCostUsdPerMillionTokens: 1,
  },
};

it("initializes all providers without historical manifests and resolves them in runtime contexts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "growthos-team-credentials-"));
  directories.push(directory);
  const root = join(directory, "secrets");
  await bootstrapTeamCredentials(root, input);
  const store = new LocalProductSecretStoreClient({ rootDirectory: root });
  for (const [reference, kind, provider, expected] of [
    [localProductAhrefsCredentialReference, secretKinds.ahrefsCredential, "ahrefs", JSON.stringify(input.ahrefs)],
    [localProductDataForSeoCredentialReference, secretKinds.dataForSeoCredential, "dataforseo", JSON.stringify(input.dataforseo)],
    [googleOauthClientSecretReference, secretKinds.googleOauthClientSecret, "google", input.google.clientSecret],
    [localProductAiProviderCredentialReference, secretKinds.aiProviderCredential, "ai", input.ai.apiKey],
  ] as const) {
    expect(await store.resolve({ reference: parseLocalProductSecretReference(reference, kind),
      context: { organizationId: "local-product", subjectProvider: provider } })).toBe(expected);
  }
  const environment = await readFile(join(directory, "backlinks-worker.env"), "utf8");
  expect(environment).toContain("AI_MODEL_ID=fixture-model");
  expect(environment).not.toContain("private-sentinel");
  await expect(bootstrapTeamCredentials(root, input)).rejects.toThrow();
  expect(await readFile(join(directory, "backlinks-worker.env"), "utf8")).toBe(environment);
});

it("validates before creating any credential files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "growthos-team-credentials-"));
  directories.push(directory);
  await expect(bootstrapTeamCredentials(join(directory, "secrets"), { ...input, ahrefs: { apiKey: "" } })).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});
