import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkLocalProductBuildIdentity,
  writeLocalProductBuildIdentity,
} from "../../scripts/local-product-build-identity.js";

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "growthos-build-id-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "dist", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(
    join(root, "scripts", "local-product-build-identity.ts"),
    "fixture\n",
  );
  return root;
}

describe("LOCAL_PRODUCT build identity", () => {
  it("accepts matching source and compiled artifacts", () => {
    const root = createFixture();
    const identity = writeLocalProductBuildIdentity(
      root,
      "2026-08-11T00:00:00.000Z",
    );

    expect(checkLocalProductBuildIdentity(root)).toEqual({
      ok: true,
      code: "OK",
      identity,
      reasons: [],
    });
  });

  it("rejects SkipBuild after source changes", () => {
    const root = createFixture();
    writeLocalProductBuildIdentity(root);
    writeFileSync(join(root, "src", "index.ts"), "export const value = 2;\n");

    expect(checkLocalProductBuildIdentity(root)).toMatchObject({
      ok: false,
      code: "LOCAL_PRODUCT_STALE_BUILD",
      reasons: ["SOURCE_FINGERPRINT_MISMATCH"],
    });
  });

  it("rejects SkipBuild after compiled artifacts change", () => {
    const root = createFixture();
    writeLocalProductBuildIdentity(root);
    writeFileSync(join(root, "dist", "index.js"), "export const value = 2;\n");

    expect(checkLocalProductBuildIdentity(root)).toMatchObject({
      ok: false,
      code: "LOCAL_PRODUCT_STALE_BUILD",
      reasons: ["ARTIFACT_FINGERPRINT_MISMATCH"],
    });
  });
});
