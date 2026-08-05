import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const configurationSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Set-LocalProductConfiguration.ps1",
    import.meta.url,
  ),
  "utf8",
);
const startSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Start-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const statusSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Status-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const restartSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Restart-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const stopSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Stop-GrowthOS-LocalProduct.ps1",
    import.meta.url,
  ),
  "utf8",
);
const signalSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Send-LocalProductConsoleBreak.ps1",
    import.meta.url,
  ),
  "utf8",
);
const processSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Invoke-LocalProductProcess.ps1",
    import.meta.url,
  ),
  "utf8",
);
const dataForSeoImportSource = readFileSync(
  new URL(
    "../../../../Import-GrowthOS-LocalProductDataForSeoCredential.ps1",
    import.meta.url,
  ),
  "utf8",
);

describe("LOCAL_PRODUCT process scripts", () => {
  it("enables Node environment proxy support only for a live loopback proxy", () => {
    expect(configurationSource).toContain(
      'throw "LOCAL_PRODUCT_LOOPBACK_PROXY_REQUIRED"',
    );
    expect(configurationSource).toContain(
      'throw "LOCAL_PRODUCT_LOOPBACK_PROXY_UNAVAILABLE"',
    );
    expect(configurationSource).toContain('NODE_USE_ENV_PROXY = "1"');
    expect(configurationSource).toContain(
      "Remove-Values $values $proxyEnvironmentNames",
    );
  });

  it("bypasses external proxies for local frontend readiness", () => {
    expect(startSource).toContain('function Wait-HttpAvailable');
    expect(startSource).toContain('--noproxy "*"');
    expect(startSource).toContain('--write-out "%{http_code}"');
  });

  it("waits for the aggregate stack status before reporting start success", () => {
    expect(startSource).toContain(
      'throw "$FilePath failed with exit code $exitCode`n$details"',
    );
    expect(statusSource).toContain("[switch]$NoFail");
    expect(statusSource).toContain("-not $healthy -and -not $NoFail");
    expect(startSource).toContain(
      "$readinessDeadline = (Get-Date).AddSeconds(120)",
    );
    expect(startSource).toContain(
      "while ((Get-Date) -lt $readinessDeadline)",
    );
    expect(startSource).toContain("-NoFail");
    expect(startSource).toContain(
      'throw "LOCAL_PRODUCT_STACK_READINESS_TIMEOUT"',
    );
    expect(statusSource).toContain("providerConfiguration");
    expect(statusSource).toContain("databaseGovernance");
    expect(statusSource).toContain("'usageLedger'");
    expect(statusSource).toContain("'killSwitches'");
    expect(statusSource).toContain("'rlsReady'");
  });

  it("bootstraps governance for every latest active Website Project", () => {
    expect(startSource).toContain("$governanceBootstrapSql");
    expect(startSource).toContain(
      "backlink_project_settings_versions",
    );
    expect(startSource).toContain(
      "backlink_retention_policy_versions",
    );
    expect(startSource).toContain("'reportingTimezone','Asia/Shanghai'");
    expect(startSource).toContain("'category','operational'");
    expect(startSource).toContain(
      "SELECT DISTINCT ON (website_project_id)",
    );
    expect(startSource).toContain("WHERE project_status='ACTIVE'");
    expect(startSource).toContain(
      "website_project_id=active.website_project_id",
    );
    expect(startSource).toContain(
      "active.website_project_id,'$layer','$capability'",
    );
  });

  it("isolates the Windows console break from the calling terminal", () => {
    expect(stopSource).toContain('"Send-LocalProductConsoleBreak.ps1"');
    expect(stopSource).toContain("-WindowStyle Hidden");
    expect(stopSource).toContain("-Wait");
    expect(stopSource).not.toContain("FreeConsole");
    expect(signalSource).toContain("GenerateConsoleCtrlEvent");
    expect(signalSource).toContain("FreeConsole");
  });

  it("enables DataForSEO only through the explicit bounded switch", () => {
    expect(configurationSource).toContain("[switch]$EnableDataForSeo");
    expect(configurationSource).toContain("function Assert-DataForSeoEnvironment");
    expect(configurationSource).toContain(
      'DATAFORSEO_ENABLED = $(if ($EnableDataForSeo) { "true" } else { "false" })',
    );
    expect(configurationSource).toContain(
      'Assert-LocalProductSecretReference `',
    );
    expect(configurationSource).toContain(
      '"dataforseo" `',
    );
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    );
    expect(configurationSource).toContain(
      "LOCAL_PRODUCT_DATAFORSEO_CALL_LIMIT_INVALID",
    );
    expect(configurationSource).toContain(
      "$endpoints = @($parsedEndpoints)",
    );
    expect(processSource).toContain(
      "$allowlist = @($parsedAllowlist)",
    );
    expect(configurationSource).toContain("DATAFORSEO_MAX_PAID_CALLS");
    expect(startSource).toContain("[switch]$EnableDataForSeo");
    expect(startSource).toContain('layer = "provider"');
    expect(startSource).toContain('provider = "dataforseo"');
  });

  it("accepts the current project-context migration head", () => {
    expect(startSource).toContain('$expectedBacklinks -ne "0042"');
    expect(statusSource).toContain(
      '$projectRecommendationContextGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain('"0042"');
    expect(startSource).toContain(
      "provider_batch_request_worker_policy",
    );
    expect(startSource).toContain(
      "provider_fetch_lease_worker_policy",
    );
    expect(startSource).toContain("backlink_contact_enrichment_jobs");
    expect(startSource).toContain(
      "0039_backlink_opportunity_contact_gate.sql",
    );
    expect(startSource).toContain(
      "0040_backlink_existing_placements.sql",
    );
    expect(startSource).toContain(
      "0041_backlink_gmail_project_bindings.sql",
    );
    expect(startSource).toContain(
      "0042_backlink_project_recommendation_context.sql",
    );
    expect(startSource).toContain("target_urls");
    expect(startSource).toContain("website_project_id");
    expect(startSource).toContain("source_contact_candidate_id");
    expect(startSource).toContain("contact_review_required");
  });

  it("enables the shared browser worker through the explicit local switch", () => {
    expect(configurationSource).toContain("[switch]$EnableBrowser");
    expect(configurationSource).toContain(
      'BROWSER_PROVIDER_ENABLED = $(if ($EnableBrowser) { "true" } else { "false" })',
    );
    expect(startSource).toContain("[switch]$EnableBrowser");
    expect(startSource).toContain("backlinks.browser.v1");
    expect(startSource).toContain('"browser-worker"');
  });

  it("enables AI and Gmail with bounded local controls and Kill Switches", () => {
    expect(configurationSource).toContain("[switch]$EnableAi");
    expect(configurationSource).toContain("[switch]$EnableGmailSend");
    expect(configurationSource).toContain("[switch]$EnableGmailSync");
    expect(configurationSource).toContain("AI_PROVIDER_MAX_CALLS");
    expect(configurationSource).toContain(
      "GMAIL_ROLLING_24_HOUR_SEND_LIMIT",
    );
    expect(configurationSource).toContain(
      "GMAIL_MINIMUM_INTERVAL_SECONDS",
    );
    expect(startSource).toContain('"AI_PROVIDER"');
    expect(startSource).toContain('"GMAIL_SEND"');
    expect(startSource).toContain('"GMAIL_SYNC"');
    expect(startSource).toContain("[switch]$EnableGmail");
    expect(startSource).toContain("if ($EnableGmail)");
    expect(startSource).toContain("gmailPollingIntervalSeconds");
    expect(startSource).toContain("$contactReconciliationSql");
    expect(startSource).toContain("o.contact_review_required=false");
    expect(startSource).toContain("backlink_gmail_workspace_bindings");
    expect(startSource).toContain("gmail.readonly");
  });

  it("restarts with the previous provider controls unless overridden", () => {
    expect(restartSource).toContain("local-product-processes.json");
    expect(restartSource).toContain("Resolve-SwitchValue");
    expect(restartSource).toContain("Resolve-IntegerValue");
    expect(restartSource).toContain(
      "-KeepInfrastructure:(-not $RestartInfrastructure)",
    );
    expect(restartSource).toContain(
      '"Start-GrowthOS-LocalProduct.ps1"',
    );
    expect(restartSource).toContain(
      "$previousState.dataForSeoEnabled",
    );
    expect(restartSource).toContain(
      "$previousState.gmailPollingIntervalSeconds",
    );
  });

  it("reports recovery facts, remaining budget, and safe error categories", () => {
    expect(statusSource).toContain("Get-RecentErrorSummary");
    expect(statusSource).toContain("$recentErrors = @(");
    expect(statusSource).toContain("recentErrors = $recentErrors");
    expect(statusSource).toContain("-and $null -ne $databaseFacts");
    expect(statusSource).toContain("'remainingMicros'");
    expect(statusSource).toContain("GMAIL_POLLING_INTERVAL_SECONDS");
    expect(statusSource).toContain("'recommendationInventory'");
    expect(statusSource).toContain("'contactCandidates'");
    expect(statusSource).toContain("'acceptedSendAttempts'");
    expect(statusSource).toContain("'mailSyncCursors'");
    expect(statusSource).toContain("'placements'");
    expect(statusSource).toContain("'monitoringObservations'");
    expect(statusSource).toContain("'tasks'");
  });

  it("provides a root secure DataForSEO credential import entrypoint", () => {
    expect(dataForSeoImportSource).toContain(
      "ops\\local-product\\Import-GrowthOS-LocalProductDataForSeoCredential.ps1",
    );
    expect(dataForSeoImportSource).toContain(
      "-DiscoveryTargets $DiscoveryTargets",
    );
    expect(dataForSeoImportSource).toContain(
      "-CredentialSecretReference $CredentialSecretReference",
    );
    expect(dataForSeoImportSource).toContain(
      "-MaxPaidCalls $MaxPaidCalls",
    );
    expect(dataForSeoImportSource).toContain("-Keywords $Keywords");
    expect(dataForSeoImportSource).toContain("-Products $Products");
    expect(dataForSeoImportSource).toContain("-TargetUrls $TargetUrls");
  });
});
