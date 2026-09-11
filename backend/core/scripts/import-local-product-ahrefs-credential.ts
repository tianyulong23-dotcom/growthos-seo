import {
  LocalProductSecretStoreClient,
  localProductAhrefsCredentialReference,
  parseLocalProductSecretReference,
} from "../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../src/modules/backlinks/ports/secret-store.port.js";
import { z } from "zod";

async function main() {
  const root = process.env.PLATFORM_SECRET_STORE_ROOT;
  if (!root) throw new Error("AHREFS_SECRET_STORE_ROOT_REQUIRED");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 8_192) throw new Error("AHREFS_IMPORT_INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  const credential = z.object({ apiKey: z.string().trim().min(1).max(4_096) }).strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  await new LocalProductSecretStoreClient({ rootDirectory: root }).importFixed({
    reference: parseLocalProductSecretReference(
      localProductAhrefsCredentialReference, secretKinds.ahrefsCredential,
    ),
    plaintext: JSON.stringify(credential),
    context: { organizationId: "local-product", subjectProvider: "ahrefs" },
  });
  console.log("Ahrefs credential imported into the existing secret store. No provider call was made.");
}

void main().catch(() => {
  console.error("AHREFS_CREDENTIAL_IMPORT_FAILED");
  process.exitCode = 1;
});
