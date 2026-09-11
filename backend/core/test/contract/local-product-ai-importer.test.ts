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
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const importerPayload = Object.freeze({
  apiKey: "local-smoke-secret-never-provider",
  providerRef: "openai",
  baseUrl: "https://sub2.indexarc.net/v1",
  modelId: "gpt-5.6-sol",
  discoveryModelId: "gpt-5.6-terra",
  modelVersion: "2026-08-03",
  maxCalls: 25,
  timeoutMs: 45_000,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_200,
  absoluteBudgetUsd: 0.1,
  inputCostUsdPerMillionTokens: 1,
  outputCostUsdPerMillionTokens: 2,
});

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
): Promise<Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>> {
  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/import-local-product-ai-credential.ts"),
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

describe("LOCAL_PRODUCT AI credential importer", () => {
  it("stores only encrypted credentials and writes fail-closed configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "growthos-ai-import-"));
    temporaryRoots.push(root);
    const runtimeRoot = join(root, "runtime");
    const manifestPath = join(root, "live-auth-manifest.json");
    await mkdir(runtimeRoot, { recursive: true });
    await Promise.all([
      writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: "growthos.live-auth.v1",
          authorization: {
            approvedBy: "local-owner",
            validUntil: new Date(Date.now() + 60_000).toISOString(),
          },
          runtime: { websiteProjectKey: "elephtv" },
          ai: {
            provider: null,
            model: null,
            credentialSecretRef: null,
          },
        }),
        "utf8",
      ),
      ...["backlinks-api.env", "backlinks-worker.env"].map((name) =>
        writeFile(
          join(runtimeRoot, name),
          "BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT\n",
          "utf8",
        )),
    ]);

    const result = await runImporter(
      importerPayload,
      manifestPath,
      runtimeRoot,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: true,
      providerRef: "openai",
      providerBaseUrl: "https://sub2.indexarc.net/v1",
      modelId: "gpt-5.6-sol",
      discoveryModelId: "gpt-5.6-terra",
      credentialSecretReference:
        "secret://growthos/local-product/ai/provider-credential/v1",
      maximumReservationUsd: 0.0208,
      maxCalls: 25,
      aiProviderEnabled: false,
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      ai: {
        baseUrl: "https://sub2.indexarc.net/v1",
        capabilities: {
          AI_DISCOVERY: {
            model: "gpt-5.6-terra",
          },
        },
        credentialSecretRef:
          "secret://growthos/local-product/ai/provider-credential/v1",
        maxCalls: 25,
      },
    });
    expect(
      await readFile(join(runtimeRoot, "backlinks-api.env"), "utf8"),
    ).toContain("AI_PROVIDER_ENABLED=false");
    expect(
      await readFile(join(runtimeRoot, "backlinks-api.env"), "utf8"),
    ).toContain("AI_PROVIDER_TIMEOUT_MS=45000");
    expect(
      await readFile(join(runtimeRoot, "backlinks-api.env"), "utf8"),
    ).toContain("AI_DISCOVERY_MODEL_ID=gpt-5.6-terra");
    expect(await readTree(root)).not.toContain(importerPayload.apiKey);
  });

  it("preserves an explicit enabled state when rotating credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "growthos-ai-import-enabled-"));
    temporaryRoots.push(root);
    const runtimeRoot = join(root, "runtime");
    const manifestPath = join(root, "live-auth-manifest.json");
    await mkdir(runtimeRoot, { recursive: true });
    await Promise.all([
      writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: "growthos.live-auth.v1",
          authorization: {
            approvedBy: "local-owner",
            validUntil: new Date(Date.now() + 60_000).toISOString(),
          },
          runtime: { websiteProjectKey: "elephtv" },
          ai: {
            provider: null,
            model: null,
            credentialSecretRef: null,
          },
        }),
        "utf8",
      ),
      ...["backlinks-api.env", "backlinks-worker.env"].map((name) =>
        writeFile(
          join(runtimeRoot, name),
          [
            "BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT",
            "AI_PROVIDER_ENABLED=true",
            "OUTBOUND_PROXY_MODE=explicit",
            "HTTP_PROXY=http://127.0.0.1:33210",
            "HTTPS_PROXY=http://127.0.0.1:33210",
            "NO_PROXY=localhost,127.0.0.1",
            "NODE_USE_ENV_PROXY=1",
            "",
          ].join("\n"),
          "utf8",
        )),
    ]);

    const result = await runImporter(
      importerPayload,
      manifestPath,
      runtimeRoot,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: true,
      aiProviderEnabled: true,
    });
    for (const name of ["backlinks-api.env", "backlinks-worker.env"]) {
      const environment = await readFile(join(runtimeRoot, name), "utf8");
      expect(environment).toContain("AI_PROVIDER_ENABLED=true");
      expect(environment).not.toMatch(
        /^(?:OUTBOUND_PROXY_MODE|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)=/mu,
      );
    }
  });
});
