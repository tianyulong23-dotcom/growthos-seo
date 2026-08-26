import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  localProductDataForSeoEndpoints,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.js";

const temporaryRoots: string[] = [];

async function readTree(root: string): Promise<string> {
  const values: string[] = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if ((await stat(path)).isDirectory()) {
      values.push(await readTree(path));
    } else {
      values.push(await readFile(path, "utf8"));
    }
  }
  return values.join("\n");
}

async function runImporter(
  payload: Record<string, unknown>,
  manifestPath: string,
  runtimeRoot: string,
) {
  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/import-local-product-dataforseo-credential.ts"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIVE_AUTH_MANIFEST_PATH: manifestPath,
        GROWTHOS_LOCAL_PRODUCT_RUNTIME_ROOT: runtimeRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(payload));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })),
  );
});

describe("LOCAL_PRODUCT DataForSEO credential importer", () => {
  it("stores encrypted credentials and leaves the provider fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "growthos-dfs-import-"));
    temporaryRoots.push(root);
    const runtimeRoot = join(root, "runtime");
    const manifestPath = join(root, "live-auth-manifest.json");
    await mkdir(runtimeRoot, { recursive: true });
    await Promise.all([
      writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: "growthos.live-auth.v1",
          runtime: { websiteProjectKey: "elephtv" },
          dataForSeo: {
            provider: null,
            credentialSecretRef: null,
          },
        }),
        "utf8",
      ),
      ...["backlinks-api.env", "backlinks-worker.env"].map((name) =>
        writeFile(
          join(runtimeRoot, name),
          "BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT\nDATAFORSEO_ENABLED=false\n",
          "utf8",
        )),
    ]);

    const login = "account@example.com";
    const password = "protected-provider-password";
    const result = await runImporter({
      login,
      password,
      credentialSecretRef:
        "secret://growthos/local-product/dataforseo/provider-credential/v7",
      endpointAllowlist: [...localProductDataForSeoEndpoints],
      timeoutMs: 60_000,
      estimatedCostMicros: 1_000,
      absoluteBudgetMicros: 5_000,
      maxPaidCalls: 25,
      candidateLimit: 25,
    }, manifestPath, runtimeRoot);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: true,
      credentialSecretReference:
        "secret://growthos/local-product/dataforseo/provider-credential/v7",
      maxPaidCalls: 25,
      dataForSeoEnabled: false,
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      dataForSeo: {
        provider: "dataforseo",
        maxCalls: 25,
        credentialSecretRef:
          "secret://growthos/local-product/dataforseo/provider-credential/v7",
      },
    });
    const workerEnvironment = await readFile(
      join(runtimeRoot, "backlinks-worker.env"),
      "utf8",
    );
    expect(workerEnvironment).toContain("DATAFORSEO_ENABLED=false");
    expect(workerEnvironment).not.toContain(
      "DATAFORSEO_DISCOVERY_TARGETS_JSON",
    );
    const allFiles = await readTree(root);
    expect(allFiles).not.toContain(login);
    expect(allFiles).not.toContain(password);
  });
});
