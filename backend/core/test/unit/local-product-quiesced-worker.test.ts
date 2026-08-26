import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  resolveWorkerExecutionMode,
} from "../../scripts/local-product-quiesced-worker.mjs";

const quiescedWorkerSource = readFileSync(
  new URL("../../scripts/local-product-quiesced-worker.mjs", import.meta.url),
  "utf8",
);
const processSource = readFileSync(
  new URL(
    "../../../../scripts/dev-up.ps1",
    import.meta.url,
  ),
  "utf8",
);
const startSource = readFileSync(
  new URL(
    "../../../../scripts/dev-up.ps1",
    import.meta.url,
  ),
  "utf8",
);
const statusSource = readFileSync(
  new URL(
    "../../../../scripts/dev-up.ps1",
    import.meta.url,
  ),
  "utf8",
);

describe("LOCAL_PRODUCT quiesced Worker", () => {
  it("defaults to the existing normal mode", () => {
    expect(resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
    })).toBe("normal");
    expect(processSource).toContain('@("dist/index.js", "worker")');
  });

  it("allows quiesced mode only for LOCAL_PRODUCT", () => {
    expect(resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
      BACKLINKS_WORKER_EXECUTION_MODE: "quiesced",
    })).toBe("quiesced");
    expect(() => resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT_ACCEPTANCE",
      BACKLINKS_WORKER_EXECUTION_MODE: "quiesced",
    })).toThrow("BACKLINKS_WORKER_QUIESCED_MODE_REQUIRES_LOCAL_PRODUCT");
    expect(() => resolveWorkerExecutionMode({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
      BACKLINKS_WORKER_EXECUTION_MODE: "paused",
    })).toThrow("BACKLINKS_WORKER_EXECUTION_MODE_UNSUPPORTED");
  });

  it("loads production composition without starting business consumers", () => {
    expect(quiescedWorkerSource).toContain(
      "await runtime.createWorkerRegistrations",
    );
    expect(quiescedWorkerSource).not.toContain("startBacklinksWorker(");
    expect(quiescedWorkerSource).not.toContain("backgroundService.start");
    expect(quiescedWorkerSource).not.toContain("worker.run");
    expect(quiescedWorkerSource).toContain(
      "const keepAlive = setInterval",
    );
    expect(quiescedWorkerSource).toContain("clearInterval(keepAlive)");
    expect(quiescedWorkerSource).toContain(
      'businessConsumersRunning: false',
    );
  });

  it("reports build and infrastructure readiness in maintenance status", () => {
    expect(quiescedWorkerSource).toContain(
      "assertLocalProductRuntimeBuildIdentity",
    );
    expect(quiescedWorkerSource).toContain("postgresReady: true");
    expect(quiescedWorkerSource).toContain("temporalReady: true");
    expect(startSource).toContain(
      '$workerExecutionMode -eq "quiesced"',
    );
    expect(startSource).toContain(
      '$runtimeStatus.status -ne "maintenance"',
    );
    expect(statusSource).toContain("core_api");
    expect(statusSource).toContain("worker");
    expect(statusSource).toContain(
      "execution_mode",
    );
    expect(statusSource).toContain(
      "business_consumers_running",
    );
    expect(statusSource).toContain("postgres_ready");
    expect(statusSource).toContain("temporal_ready");
  });

  it("starts recovery through the standard Worker without normal consumers", () => {
    expect(startSource).toContain(
      '"RECOVERY" {',
    );
    expect(startSource).toContain(
      '$desiredWorkerExecutionMode = "recovery"',
    );
    expect(startSource).toContain(
      '$desiredPlatformBackgroundDispatchEnabled = "false"',
    );
  });

  it("keeps PRODUCT providers configured with business dispatch enabled", () => {
    expect(startSource).toContain(
      '"app.main:app"',
    );
    expect(startSource).toContain(
      '"node_modules\\vite\\bin\\vite.js"',
    );
    expect(startSource).toContain('-ExpectedCommand "vite.js"');
    expect(startSource).toContain(
      'Wait-ForUrl "Platform API"',
    );
    expect(startSource).toContain(
      'Wait-ForUrl "Frontend"',
    );
    expect(startSource).toContain(
      '$desiredPlatformBackgroundDispatchEnabled = "true"',
    );
    expect(startSource).toContain(
      '$desiredBacklinksProjectProjectionEnabled = "true"',
    );
    expect(startSource).toContain(
      "Assert-ProviderEnabled $providerFlag",
    );
    expect(startSource).toContain(
      '$dataForSeoDefaultAvailability = if ($growthosRuntimeMode -eq "PRODUCT")',
    );
    expect(startSource).toContain(
      '"DATAFORSEO_EXTERNAL_AVAILABILITY" `\n    $dataForSeoDefaultAvailability',
    );
    expect(startSource).toContain(
      'Get-LocalSetting "BROWSER_PROVIDER_EXTERNAL_AVAILABILITY" "not_checked"',
    );
    expect(startSource).toContain(
      'Get-LocalSetting "AI_PROVIDER_ENABLED" "false"',
    );
    expect(startSource).not.toContain(
      'Assert-ProviderDisabled "AI_PROVIDER_ENABLED"',
    );
    expect(startSource).not.toContain('AI_PROVIDER_ENABLED = "false"');
    expect(startSource).toContain(
      'AI_PROVIDER_ENABLED = $aiProviderEnabled',
    );
    expect(startSource).toContain('"backlinks-worker.env"');
    expect(startSource).toContain(
      '"AI_PROVIDER_CREDENTIAL_SECRET_REF"',
    );
    expect(startSource).toContain(
      "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_MISSING",
    );
    expect(startSource).not.toContain(
      '$env:DATAFORSEO_EXTERNAL_AVAILABILITY = $null',
    );
    expect(startSource).not.toContain(
      '$env:BROWSER_PROVIDER_EXTERNAL_AVAILABILITY = $null',
    );
  });

  it("fails closed before startup when enabled AI has no managed configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "growthos-ai-startup-"));
    try {
      const environmentPath = join(root, ".env");
      const repositoryRoot = resolve(process.cwd(), "..", "..");
      const environment = readFileSync(
        join(repositoryRoot, "deploy", "compose", ".env.example"),
        "utf8",
      );
      writeFileSync(
        environmentPath,
        [
          environment,
          "AI_PROVIDER_ENABLED=true",
          "GOOGLE_OAUTH_CLIENT_ID=test-client-id",
          "GOOGLE_OAUTH_CLIENT_SECRET_REF=secret://test/google-oauth",
          "GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8000/api/v1/backlinks/gmail-connections/callback",
          "BACKLINKS_OAUTH_FRONTEND_ORIGIN=http://localhost:5173",
          `PLATFORM_SECRET_STORE_ROOT=${join(root, "missing", "secrets")}`,
          `COMPOSE_PROJECT_NAME=ai-missing-${process.pid}`,
          "",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(repositoryRoot, "scripts", "dev-up.ps1"),
          "-EnvironmentFile",
          environmentPath,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_MISSING",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves managed process timestamp precision across restarts", () => {
    expect(processSource).toContain(
      "[datetime]$Record.startedAtUtc",
    );
    expect(processSource).not.toContain(
      "[datetime]::Parse(",
    );
    expect(processSource).toContain("$startDeltaSeconds -lt 1");
    expect(processSource).toContain("Assert-PortAvailable");
    expect(
      processSource.split("Assert-ManagedProcessRunning `").length - 1,
    ).toBe(8);
  });

  it("keeps the Platform API process tree rooted in the managed Python process", () => {
    expect(processSource).toContain(
      '$platformPython = Join-Path $apiDir ".venv\\Scripts\\python.exe"',
    );
    expect(processSource).toContain(
      '-FilePath $platformPython `',
    );
    expect(processSource).toMatch(
      /"-m",\r?\n\s+"uvicorn",\r?\n\s+"app\.main:app"/u,
    );
    expect(processSource).toContain(
      '-ExpectedCommand "-m uvicorn app.main:app"',
    );
    expect(processSource).not.toContain(
      '-FilePath $uvicorn `',
    );
  });
});
