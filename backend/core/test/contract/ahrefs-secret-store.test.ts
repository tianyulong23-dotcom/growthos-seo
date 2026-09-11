import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalProductSecretStoreClient, localProductAhrefsCredentialReference, parseLocalProductSecretReference,
} from "../../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../../src/modules/backlinks/ports/secret-store.port.js";

describe("Ahrefs existing server secret store", () => {
  it("round trips the fixed reference without plaintext persistence or provider calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "growthos-ahrefs-secret-test-"));
    try {
      const client = new LocalProductSecretStoreClient({ rootDirectory: root });
      const reference = parseLocalProductSecretReference(localProductAhrefsCredentialReference, secretKinds.ahrefsCredential);
      const context = { organizationId: "local-product", subjectProvider: "ahrefs" } as const;
      const plaintext = JSON.stringify({ apiKey: "fixture-ahrefs-private-key" });
      await client.importFixed({ reference, context, plaintext });
      expect(await client.resolve({ reference, context })).toBe(plaintext);
      const files = await readdir(join(root, "values"), { recursive: true, withFileTypes: true });
      for (const file of files.filter((entry) => entry.isFile())) {
        expect(await readFile(join(file.parentPath, file.name), "utf8")).not.toContain("fixture-ahrefs-private-key");
      }
      expect(() => parseLocalProductSecretReference(localProductAhrefsCredentialReference, secretKinds.dataForSeoCredential)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
