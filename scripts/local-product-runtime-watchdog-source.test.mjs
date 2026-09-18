import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ensureSource = await readFile(
  new URL("./ensure-local-product-runtime.ps1", import.meta.url),
  "utf8",
);
const installSource = await readFile(
  new URL("./install-local-product-runtime-watchdog.ps1", import.meta.url),
  "utf8",
);
const devUpSource = await readFile(
  new URL("./dev-up.ps1", import.meta.url),
  "utf8",
);
const environmentExampleSource = await readFile(
  new URL("../deploy/compose/.env.example", import.meta.url),
  "utf8",
);
const sendIntentSource = await readFile(
  new URL(
    "../backend/core/src/modules/backlinks/application/commands/send-intent.command.ts",
    import.meta.url,
  ),
  "utf8",
);
const draftEvidencePolicySource = await readFile(
  new URL(
    "../backend/core/src/modules/backlinks/domain/drafts/evidence-policy.ts",
    import.meta.url,
  ),
  "utf8",
);

test("local startup registers an Agent worker after the Platform API", () => {
  const start = devUpSource.indexOf("$agentWorkerProcess = Start-Process");
  assert.ok(start > devUpSource.indexOf("$platformApiProcess = Start-Process"));
  const worker = devUpSource.slice(start, start + 1000);
  assert.ok(worker.includes('"-m", "app.workflows.agent_worker"'));
  assert.ok(worker.includes('-Name "Agent Worker"'));
  assert.ok(worker.includes("-WindowStyle Hidden"));
  assert.ok(worker.includes("Register-ManagedProcess"));
  assert.ok(worker.includes("Assert-ManagedProcessRunning"));
});

test("watchdog requires the complete PRODUCT process chain", () => {
  for (const required of [
    "runtime.mode",
    "business_consumers_running",
    "core_api.running",
    "worker.process_running",
    "worker.execution_mode",
    "worker.postgres_ready",
    "worker.temporal_ready",
    "build.current",
    "platform.background_dispatch_enabled",
    "platform.project_context_projection_enabled",
    "platform.project_context_dispatcher_running",
  ]) {
    assert.match(
      ensureSource,
      new RegExp(required.replaceAll(".", "\\."), "i"),
    );
  }
  for (const required of [
    "GOOGLE_OAUTH_ENABLED",
    "GMAIL_SEND_ENABLED",
    "GMAIL_SYNC_ENABLED",
  ]) {
    assert.match(
      ensureSource,
      new RegExp(`Get-LocalSetting "${required}"`),
    );
  }
  assert.match(ensureSource, /Start-Sleep -Seconds 5/);
  assert.match(ensureSource, /dev-down\.ps1/);
  assert.match(ensureSource, /dev-up\.ps1/);
});

test("watchdog rebuilds when the local PRODUCT build is stale", () => {
  assert.match(ensureSource, /function Test-LocalProductBuildCurrent/);
  assert.match(
    ensureSource,
    /local-product:build-identity:check/,
  );
  assert.match(ensureSource, /LOCAL_PRODUCT_STALE_BUILD/);
  assert.match(
    ensureSource,
    /LOCAL_PRODUCT_RUNTIME_RECOVERY_BUILD_STALE/,
  );
  assert.match(ensureSource, /function Get-ExpectedLocalProductBuildId/);
  assert.match(
    ensureSource,
    /\$Runtime\.core_api\.build_id -eq \$ExpectedBuildId/,
  );
  assert.match(
    ensureSource,
    /\$Runtime\.worker\.build_id -eq \$ExpectedBuildId/,
  );
  assert.match(devUpSource, /BACKLINKS_EXPECTED_BUILD_ID = \$buildId/);
});

test("PRODUCT startup requires all background consumers and provider capabilities", () => {
  for (const required of [
    "GROWTHOS_RUNTIME_MODE",
    "GROWTHOS_RUNTIME_MODE_WORKER_CONFLICT",
    "GROWTHOS_RUNTIME_MODE_BACKGROUND_DISPATCH_CONFLICT",
    "GROWTHOS_RUNTIME_MODE_PROJECT_PROJECTION_CONFLICT",
  ]) {
    assert.match(devUpSource, new RegExp(required));
  }
  assert.match(
    devUpSource,
    /if \(\$growthosRuntimeMode -eq "PRODUCT"\) \{\s*Assert-ProviderEnabled \$providerFlag\s*\}/,
  );
  assert.doesNotMatch(devUpSource, /M1C_GMAIL_ACTIONS_MUST_REMAIN_DISABLED/);
  for (const required of [
    "GROWTHOS_RUNTIME_MODE=PRODUCT",
    "BACKLINKS_WORKER_EXECUTION_MODE=normal",
    "PLATFORM_BACKGROUND_DISPATCH_ENABLED=true",
    "BACKLINKS_PROJECT_PROJECTION_ENABLED=true",
    "DATAFORSEO_ENABLED=true",
    "DATAFORSEO_EXTERNAL_AVAILABILITY=available",
    "DATAFORSEO_ABSOLUTE_BUDGET_MICROS=5000000",
    "DATAFORSEO_MAX_PAID_CALLS=25",
    "AI_PROVIDER_ENABLED=true",
    "GOOGLE_OAUTH_ENABLED=true",
    "GMAIL_SEND_ENABLED=true",
    "GMAIL_SYNC_ENABLED=true",
  ]) {
    assert.match(environmentExampleSource, new RegExp(`^${required}$`, "m"));
  }
});

test("PRODUCT DataForSEO traffic bypasses an optional outbound proxy", () => {
  assert.match(devUpSource, /function Add-NoProxyHost/);
  assert.match(
    devUpSource,
    /-HostName "api\.dataforseo\.com"/,
  );
  assert.match(
    environmentExampleSource,
    /^NO_PROXY=127\.0\.0\.1,localhost,api\.dataforseo\.com$/m,
  );
});

test("provider degradation is reported without restarting healthy processes", () => {
  assert.match(ensureSource, /Write-ProviderDegradation/);
  assert.match(ensureSource, /Provider degraded; no process restart/);
  assert.doesNotMatch(
    ensureSource.match(/function Test-ProcessRuntimeReady[\s\S]*?^}/m)?.[0] ?? "",
    /providers\./,
  );
});

test("managed recovery uses child exit codes instead of native stderr", () => {
  assert.match(ensureSource, /function Invoke-ManagedRuntimeScript/);
  assert.match(ensureSource, /Start-Process/);
  assert.match(ensureSource, /-WindowStyle Hidden/);
  assert.match(ensureSource, /-RedirectStandardOutput \$stdoutPath/);
  assert.match(ensureSource, /-RedirectStandardError \$stderrPath/);
  assert.match(ensureSource, /\$process\.WaitForExit\(\)/);
  assert.match(ensureSource, /\$process\.ExitCode/);
  assert.match(ensureSource, /\$process\.Dispose\(\)/);
  assert.match(ensureSource, /function Copy-ManagedOutputToWatchdogLog/);
  assert.match(ensureSource, /\[System\.IO\.FileShare\]::ReadWrite/);
  assert.match(ensureSource, /Start-Sleep -Milliseconds 250/);
  assert.match(ensureSource, /\[guid\]::NewGuid\(\)\.ToString\("N"\)/);
  assert.match(ensureSource, /Copy-ManagedOutputToWatchdogLog \$outputPath/);
  assert.match(ensureSource, /recovery result preserved/);
  assert.doesNotMatch(
    ensureSource.match(/function Invoke-ManagedRuntimeScript[\s\S]*?^}/m)?.[0] ??
      "",
    /-Wait\b/,
  );
  assert.match(ensureSource, /LOCAL_PRODUCT_RUNTIME_START_FAILED exit_code=/);
  assert.doesNotMatch(ensureSource, /\*>> \$logPath/);
});

test("PRODUCT restart reuses a verified unchanged Crawler Worker build", () => {
  for (const required of [
    "Get-Sha256FileFingerprint",
    "Get-CrawlerSourceFingerprint",
    "Test-CrawlerBuildCurrent",
    "crawler-worker-docker.build.json",
    "growthos.crawler-build.v1",
    "artifactFingerprint",
    "legacy_artifact_source_mtime",
    "reusing the verified executable",
  ]) {
    assert.match(devUpSource, new RegExp(required));
  }
  assert.doesNotMatch(devUpSource, /Get-FileHash/);
  assert.match(
    devUpSource,
    /if \(Test-CrawlerBuildCurrent -SourceFingerprint \$sourceFingerprint\) \{[\s\S]*?return/,
  );
  assert.match(
    devUpSource,
    /\$completedSourceFingerprint = Get-CrawlerSourceFingerprint[\s\S]*?\$completedSourceFingerprint -ne \$sourceFingerprint[\s\S]*?Crawler Worker source changed during build/,
  );
  assert.match(
    devUpSource,
    /Write-CrawlerBuildMetadata\s+`\s+-SourceFingerprint \$completedSourceFingerprint\s+`\s+-Provenance "source_build"/,
  );
});

test("scheduled task runs hidden at logon and every five minutes", () => {
  assert.match(installSource, /-WindowStyle Hidden/);
  assert.match(installSource, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(installSource, /New-TimeSpan -Minutes 5/);
  assert.match(installSource, /-MultipleInstances IgnoreNew/);
});

test("watchdog does not enable outbound Gmail actions", () => {
  assert.doesNotMatch(ensureSource, /GMAIL_(SEND|SYNC)_ENABLED\s*=\s*"true"/);
  assert.doesNotMatch(installSource, /GMAIL_(SEND|SYNC)_ENABLED\s*=\s*"true"/);
});

test("always-on Gmail capability preserves per-message human confirmation", () => {
  assert.match(sendIntentSource, /input\.humanConfirmation\.confirmed !== true/);
  assert.match(
    draftEvidencePolicySource,
    /input\.output\.requiresUserConfirmation !== true/,
  );
  assert.match(draftEvidencePolicySource, /input\.output\.canAutoSend !== false/);
});
