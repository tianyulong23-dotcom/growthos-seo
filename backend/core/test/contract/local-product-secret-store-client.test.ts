import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalProductSecretStoreClient,
  googleOauthClientSecretReference,
  localProductAiProviderCredentialReference,
  localProductGmailCanaryRecipientReference,
  parseLocalProductSecretReference,
} from "../../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import {
  secretKinds,
  secretStoreFailureCodes,
} from "../../src/modules/backlinks/ports/secret-store.port.js";

const roots: string[] = [];
const context = {
  organizationId: "local-product",
  subjectProvider: "google",
} as const;

const createClient = async () => {
  const root = await mkdtemp(join(tmpdir(), "growthos-secret-store-"));
  roots.push(root);
  return { root, client: new LocalProductSecretStoreClient({
    rootDirectory: root,
    newId: () => "018f0000-0000-7000-8000-000000000001",
  }) };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("local product Secret Store client", () => {
  it("encrypts, resolves, rotates, and destroys versioned secrets", async () => {
    const { root, client } = await createClient();
    const created = await client.create({
      secretKind: secretKinds.googleOauthClientSecret,
      plaintext: "client-secret-value",
      context,
    });
    const reference = {
      provider: "platform-secret-store",
      secretKind: secretKinds.googleOauthClientSecret,
      ...created,
    } as const;

    await expect(client.resolve({ reference, context }))
      .resolves.toBe("client-secret-value");
    const rotated = await client.rotate({
      reference,
      plaintext: "rotated-client-secret-value",
      context,
    });
    expect(rotated.externalSecretVersion).toBe("v2");
    await expect(client.resolve({
      reference: { ...reference, ...rotated },
      context,
    })).resolves.toBe("rotated-client-secret-value");

    const storedFiles = await readdir(join(root, "values"), {
      recursive: true,
      withFileTypes: true,
    });
    const storedContents = await Promise.all(storedFiles
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
    expect(storedContents.join("\n")).not.toContain("client-secret-value");

    await client.destroy({ reference, context });
    await expect(client.resolve({ reference, context })).rejects.toMatchObject({
      code: secretStoreFailureCodes.notFound,
    });
  });

  it("imports the fixed OAuth client reference without exposing plaintext", async () => {
    const { root, client } = await createClient();
    const reference = parseLocalProductSecretReference(
      googleOauthClientSecretReference,
      secretKinds.googleOauthClientSecret,
    );
    await client.importFixed({
      reference,
      plaintext: "fixed-client-secret",
      context,
    });

    await expect(client.resolve({ reference, context }))
      .resolves.toBe("fixed-client-secret");
    expect(await readFile(join(root, "master-key.bin"))).toHaveLength(32);
    expect(JSON.stringify(client)).not.toContain("fixed-client-secret");
  });

  it("imports the fixed Gmail Canary recipient as encrypted secret data", async () => {
    const { root, client } = await createClient();
    const reference = parseLocalProductSecretReference(
      localProductGmailCanaryRecipientReference,
      secretKinds.gmailCanaryRecipient,
    );
    const recipient = ["canary-recipient", "example.invalid"].join("@");
    await client.importFixed({
      reference,
      plaintext: recipient,
      context,
    });

    await expect(client.resolve({ reference, context })).resolves.toBe(
      recipient,
    );
    const storedFiles = await readdir(join(root, "values"), {
      recursive: true,
      withFileTypes: true,
    });
    const storedContents = await Promise.all(storedFiles
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
    expect(storedContents.join("\n")).not.toContain(recipient);
  });

  it("imports the fixed AI credential without storing plaintext", async () => {
    const { root, client } = await createClient();
    const reference = parseLocalProductSecretReference(
      localProductAiProviderCredentialReference,
      secretKinds.aiProviderCredential,
    );
    await client.importFixed({
      reference,
      plaintext: "protected-ai-provider-key",
      context: {
        organizationId: "local-product",
        subjectProvider: "ai",
      },
    });

    await expect(client.resolve({
      reference,
      context: {
        organizationId: "local-product",
        subjectProvider: "ai",
      },
    })).resolves.toBe("protected-ai-provider-key");
    const storedFiles = await readdir(join(root, "values"), {
      recursive: true,
      withFileTypes: true,
    });
    const storedContents = await Promise.all(storedFiles
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
    expect(storedContents.join("\n")).not.toContain(
      "protected-ai-provider-key",
    );
  });

  it("accepts versioned same-kind references and rejects kind mismatches", () => {
    expect(parseLocalProductSecretReference(
      "secret://growthos/local-product/ai/provider-credential/v7",
      secretKinds.aiProviderCredential,
    )).toMatchObject({
      externalSecretId: "ai/provider-credential",
      externalSecretVersion: "v7",
    });
    expect(() => parseLocalProductSecretReference(
      "secret://growthos/local-product/google/oauth-client-secret/v1",
      secretKinds.aiProviderCredential,
    )).toThrow("Local product Secret Reference kind is invalid.");
  });

  it("rejects a mismatched encryption context", async () => {
    const { client } = await createClient();
    const created = await client.create({
      secretKind: secretKinds.googleOauthClientSecret,
      plaintext: "client-secret-value",
      context,
    });
    await expect(client.resolve({
      reference: {
        provider: "platform-secret-store",
        secretKind: secretKinds.googleOauthClientSecret,
        ...created,
      },
      context: { ...context, organizationId: "other" },
    })).rejects.toMatchObject({
      code: secretStoreFailureCodes.invalidRequest,
    });
  });
});
