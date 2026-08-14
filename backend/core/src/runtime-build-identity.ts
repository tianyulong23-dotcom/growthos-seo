import { readFileSync } from "node:fs";
import { z } from "zod";

const localProductBuildIdentitySchema = z
  .object({
    schemaVersion: z.literal("growthos.local-product-build.v1"),
    buildId: z.string().trim().min(1),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    builtAt: z.iso.datetime(),
  })
  .strict();

export type LocalProductRuntimeBuildIdentity = z.output<
  typeof localProductBuildIdentitySchema
>;

export function readLocalProductRuntimeBuildIdentity():
  LocalProductRuntimeBuildIdentity {
  return localProductBuildIdentitySchema.parse(JSON.parse(
    readFileSync(
      new URL("./local-product-build-identity.json", import.meta.url),
      "utf8",
    ),
  ));
}

export function assertLocalProductRuntimeBuildIdentity(
  configuredBuildId: string,
): LocalProductRuntimeBuildIdentity {
  const identity = readLocalProductRuntimeBuildIdentity();
  if (identity.buildId !== configuredBuildId) {
    throw new Error("LOCAL_PRODUCT_STALE_BUILD");
  }
  return identity;
}
