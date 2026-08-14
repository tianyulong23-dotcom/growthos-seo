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
const rootStartSource = readFileSync(
  new URL("../../../../Start-GrowthOS-LocalProduct.ps1", import.meta.url),
  "utf8",
);
const dataForSeoBudgetCycleSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Open-GrowthOS-LocalProductDataForSeoBudgetCycle.ps1",
    import.meta.url,
  ),
  "utf8",
);
const dataForSeoReconciliationSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Resolve-GrowthOS-LocalProductDataForSeoUnknownCharge.ps1",
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
const initializeProjectSource = readFileSync(
  new URL(
    "../../../../ops/local-product/Initialize-GrowthOS-LocalProductProject.ps1",
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
const backlinkProfileRuntimeSource = readFileSync(
  new URL(
    "../../src/modules/backlinks/runtime/local-product-backlink-profile-runtime.ts",
    import.meta.url,
  ),
  "utf8",
);
const localProductManifestExample = readFileSync(
  new URL(
    "../../../../ops/local-product/local-product-auth-manifest.example.json",
    import.meta.url,
  ),
  "utf8",
);
const localProductIdentityExample = readFileSync(
  new URL(
    "../../../../ops/local-product/local-product-identity.example.json",
    import.meta.url,
  ),
  "utf8",
);
const localProductProviderEnvironmentExample = readFileSync(
  new URL(
    "../../../../ops/local-product/local-product-provider.env.example",
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

  it("ships portable local-product examples without raw provider secrets", () => {
    expect(() => JSON.parse(localProductManifestExample)).not.toThrow();
    expect(() => JSON.parse(localProductIdentityExample)).not.toThrow();
    expect(localProductManifestExample).toContain(
      "secret://growthos/local-product/google/oauth-client-secret/v1",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "secret://growthos/local-product/dataforseo/provider-credential/v1",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "DATAFORSEO_ABSOLUTE_BUDGET_MICROS=1000000",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "DATAFORSEO_MAX_PAID_CALLS=250",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "DATAFORSEO_ENABLED=false",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "GMAIL_SEND_ENABLED=false",
    );
    expect(localProductProviderEnvironmentExample).toContain(
      "GMAIL_SYNC_ENABLED=false",
    );
    for (const example of [
      localProductManifestExample,
      localProductIdentityExample,
      localProductProviderEnvironmentExample,
    ]) {
      expect(example).not.toMatch(/C:\\Users\\/i);
      expect(example).not.toMatch(/authorization\s*=/i);
      expect(example).not.toMatch(/password\s*=/i);
    }
  });

  it("bypasses external proxies for local frontend readiness", () => {
    expect(startSource).toContain("function Wait-HttpAvailable");
    expect(startSource).toContain('--noproxy "*"');
    expect(startSource).toContain('--write-out "%{http_code}"');
    expect(startSource).toContain(
      "$previousErrorActionPreference = $ErrorActionPreference",
    );
    expect(startSource).toContain('$ErrorActionPreference = "Continue"');
    expect(startSource).toContain(
      "$ErrorActionPreference = $previousErrorActionPreference",
    );
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
    expect(startSource).toContain("while ((Get-Date) -lt $readinessDeadline)");
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

  it("fails closed on stale SkipBuild and reports one runtime build identity", () => {
    expect(startSource).toContain("LOCAL_PRODUCT_STALE_BUILD");
    expect(startSource).toContain("Get-LocalProductBuildIdentity");
    expect(startSource).toContain("$state.buildId");
    expect(startSource).toContain("$response.build.buildId");
    expect(restartSource).toContain(
      '"run" "local-product:build-identity:check"',
    );
    expect(statusSource).toContain("$expectedBuildId");
    expect(statusSource).toContain("$apiBuildId");
    expect(statusSource).toContain("$workerBuildId");
    expect(statusSource).toContain("$buildReady");
    expect(statusSource).toContain(
      "-SimpleMatch '\"event\":\"backlinks.worker.ready\"'",
    );
    expect(statusSource).not.toContain(
      "Get-Content -LiteralPath $path -Tail 200",
    );
  });

  it("bootstraps governance for every latest active Website Project", () => {
    expect(startSource).toContain("$governanceBootstrapSql");
    expect(startSource).toContain("backlink_project_settings_versions");
    expect(startSource).toContain("backlink_retention_policy_versions");
    expect(startSource).toContain("'reportingTimezone','Asia/Shanghai'");
    expect(startSource).toContain("'category','operational'");
    expect(startSource).toContain("SELECT DISTINCT ON (website_project_id)");
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

  it("keeps DataForSEO bounded and restores an available local secret profile", () => {
    expect(configurationSource).toContain("[switch]$EnableDataForSeo");
    expect(configurationSource).toContain(
      "function Assert-DataForSeoEnvironment",
    );
    expect(configurationSource).toContain(
      'DATAFORSEO_ENABLED = $(if ($EnableDataForSeo) { "true" } else { "false" })',
    );
    expect(configurationSource).toContain(
      "Assert-LocalProductSecretReference `",
    );
    expect(configurationSource).toContain('"dataforseo" `');
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    );
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/backlinks/summary/live",
    );
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/backlinks/backlinks/live",
    );
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    );
    expect(configurationSource).toContain(
      "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
    );
    expect(dataForSeoImportSource).toContain(
      "https://api.dataforseo.com/v3/backlinks/competitors/live",
    );
    expect(configurationSource).toContain(
      "LOCAL_PRODUCT_DATAFORSEO_CALL_LIMIT_INVALID",
    );
    expect(configurationSource).toContain("$endpoints = @($parsedEndpoints)");
    expect(processSource).toContain("$allowlist = @($parsedAllowlist)");
    expect(configurationSource).toContain("DATAFORSEO_MAX_PAID_CALLS");
    expect(configurationSource).toContain(
      "[int]$DataForSeoRequestTimeoutMs = 300000",
    );
    expect(configurationSource).toContain(
      "DATAFORSEO_REQUEST_TIMEOUT_MS = [string]$DataForSeoRequestTimeoutMs",
    );
    expect(startSource).toContain("[switch]$EnableDataForSeo");
    expect(startSource).toContain("Resolve-DataForSeoEnabled");
    expect(startSource).toContain("Resolve-DataForSeoMaxPaidCalls");
    expect(startSource).toContain(
      '$scriptBoundParameters.ContainsKey("EnableDataForSeo")',
    );
    expect(startSource).toContain(
      '$scriptBoundParameters.ContainsKey("DataForSeoMaxPaidCalls")',
    );
    expect(startSource).toContain("DATAFORSEO_CREDENTIAL_SECRET_REF");
    expect(startSource).toContain('"DATAFORSEO_CREDENTIAL"');
    expect(startSource).toContain('"master-key.bin"');
    expect(startSource).toContain('$env:CI -eq "true"');
    expect(startSource).toContain(
      '"LOCAL_PRODUCT_DATAFORSEO_CONFIG_REQUIRED:"',
    );
    expect(startSource).toContain("[switch]$PreflightOnly");
    expect(configurationSource).toContain("[switch]$ValidateOnly");
    expect(configurationSource).toContain("if (-not $ValidateOnly)");
    expect(rootStartSource).toContain(
      "foreach ($name in $PSBoundParameters.Keys)",
    );
    expect(rootStartSource).toContain("[switch]$PreflightOnly");
    expect(startSource).toContain('layer = "provider"');
    expect(startSource).toContain('provider = "dataforseo"');
    expect(startSource).toContain("active_project AS (");
    expect(startSource).toContain(
      "WHERE website_project_id='$websiteProjectId'::uuid",
    );
    expect(startSource).toContain("FROM active_project active");
  });

  it("projects Worker maintenance state into the public Gateway", () => {
    expect(configurationSource).toContain(
      '$businessConsumersExpected = $WorkerExecutionMode -eq "normal"',
    );
    expect(configurationSource).toContain(
      "BACKLINKS_BUSINESS_CONSUMERS_EXPECTED",
    );
    expect(configurationSource).toContain(
      'TEMPORAL_NAMESPACE = "growthos-backlinks-canary"',
    );
    expect(configurationSource).toContain(
      'BACKLINKS_TASK_QUEUE = "growthos.backlinks.v1"',
    );
    expect(configurationSource).toContain(
      'RUNTIME_DEPENDENCY_CHECKS_ENABLED = "true"',
    );
  });

  it("opens a governed DataForSEO budget cycle without rewriting history", () => {
    expect(dataForSeoBudgetCycleSource).toContain("pg_advisory_xact_lock");
    expect(dataForSeoBudgetCycleSource).toContain(
      "[int64]$ApprovedLimitMicros = 1000000",
    );
    expect(dataForSeoBudgetCycleSource).toContain("[int]$MaxPaidCalls = 250");
    expect(dataForSeoBudgetCycleSource).toContain(
      "LOCAL_PRODUCT_DATAFORSEO_BUDGET_RESERVATION_ACTIVE",
    );
    expect(dataForSeoBudgetCycleSource).toContain(
      "LOCAL_PRODUCT_DATAFORSEO_CHARGE_RECONCILIATION_REQUIRED",
    );
    expect(dataForSeoBudgetCycleSource).toContain(
      "current_paid_call_count < $MaxPaidCalls",
    );
    expect(dataForSeoBudgetCycleSource).toContain(
      "status IN ('reserved','settled')",
    );
    expect(dataForSeoBudgetCycleSource).toContain(
      "'previousPaidCallCount'",
    );
    expect(dataForSeoBudgetCycleSource).toContain("'currentPaidCallCount'");
    expect(dataForSeoBudgetCycleSource).toContain(
      "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
    );
    expect(dataForSeoBudgetCycleSource).toContain("DATAFORSEO_MAX_PAID_CALLS");
    expect(dataForSeoBudgetCycleSource).toContain(
      "'local-product-budget-cycle'",
    );
    expect(dataForSeoBudgetCycleSource).not.toContain(
      "DELETE FROM backlinks.backlink_provider_usage_ledger",
    );
    expect(dataForSeoBudgetCycleSource).not.toContain(
      "UPDATE backlinks.backlink_provider_usage_ledger",
    );
  });

  it("reconciles an unknown charge explicitly without deleting its audit trail", () => {
    expect(dataForSeoReconciliationSource).toContain(
      "[switch]$AssumeChargedAtReservation",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "[switch]$AssumeNotDispatched",
    );
    expect(dataForSeoReconciliationSource).toContain("pg_advisory_xact_lock");
    expect(dataForSeoReconciliationSource).toContain(
      "DATAFORSEO_RECONCILED_ASSUMED_CHARGE_NO_RESULT",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "AND batch.status='running'",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "AND request_row.status='running'",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "AND lease.status='acquired'",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "AND lease.lease_expires_at<=reconciled_at",
    );
    expect(dataForSeoReconciliationSource).toContain("status='settled'");
    expect(dataForSeoReconciliationSource).toContain(
      "reserved_micros=reserved_micros-ledger.estimated_cost_micros",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "spent_micros=spent_micros+ledger.estimated_cost_micros",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "SET status='released',released_at=reconciled_at",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "'officialAccountBalanceQueried',false",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "backlinks.backlink_profile_sync_jobs",
    );
    expect(dataForSeoReconciliationSource).toContain(
      "'requestKind',result.request_kind",
    );
    expect(dataForSeoReconciliationSource).not.toContain(
      "DELETE FROM backlinks.",
    );
  });

  it("accepts the exact-ten Website Project migration head", () => {
    expect(startSource).toContain('$expectedBacklinks -ne "0060"');
    expect(startSource).toContain("Invoke-LocalProductAlembicUpgrade");
    expect(startSource).toContain("ALEMBIC_DATABASE_URL");
    expect(startSource).toContain("postgres-admin-password");
    expect(configurationSource).toContain(
      'if ($name -eq "backlinks-worker.env")',
    );
    expect(configurationSource).toContain('"LOCAL_PRODUCT_WEBSITE_PROJECT_ID"');
    expect(configurationSource).toContain(
      '"LOCAL_PRODUCT_WEBSITE_PROJECT_KEY"',
    );
    expect(statusSource).toContain(
      '$projectRecommendationContextGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$projectScopeProviderGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$platformProjectAuthorityGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$commercialCandidateInventoryGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$gmailOrganizationReuseGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$draftRequestSnapshotGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$gmailSendReplyLoopGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      '$backlinkProfileInventoryGateReady.Trim() -eq "true"',
    );
    expect(statusSource).toContain(
      "$backlinkRecommendationPublicationDefaultGateReady.Trim()",
    );
    expect(statusSource).toContain("backlink_inventory_monitor_policies");
    expect(statusSource).toContain("backlink_inventory_monitor_observations");
    expect(statusSource).toContain('"0060"');
    expect(startSource).toContain("provider_batch_request_worker_policy");
    expect(startSource).toContain("provider_fetch_lease_worker_policy");
    expect(startSource).toContain("backlink_contact_enrichment_jobs");
    expect(startSource).toContain("0039_backlink_opportunity_contact_gate.sql");
    expect(startSource).toContain("0040_backlink_existing_placements.sql");
    expect(startSource).toContain("0041_backlink_gmail_project_bindings.sql");
    expect(startSource).toContain(
      "column_name='website_project_id'\n))::text;",
    );
    expect(startSource).toContain(
      "0042_backlink_project_recommendation_context.sql",
    );
    expect(startSource).toContain("0043_backlink_project_scope_provider.sql");
    expect(startSource).toContain(
      "0044_backlink_platform_project_authority.sql",
    );
    expect(startSource).toContain(
      "0045_backlink_commercial_candidate_inventory.sql",
    );
    expect(startSource).toContain("0046_backlink_contact_publication_gate.sql");
    expect(startSource).toContain("0047_backlink_gmail_organization_reuse.sql");
    expect(startSource).toContain("0048_backlink_draft_request_snapshots.sql");
    expect(startSource).toContain("0049_backlink_gmail_send_reply_loop.sql");
    expect(startSource).toContain(
      "0050_backlink_profile_inventory.sql",
      "0051_backlink_inventory_monitoring.sql",
    );
    expect(startSource).toContain(
      "0052_backlink_recommendation_publication_default.sql",
    );
    expect(startSource).toContain("0053_backlink_monitoring_continuity.sql");
    expect(startSource).toContain(
      "0054_backlink_recommendation_fit_contact_contract.sql",
    );
    expect(startSource).toContain("0055_backlink_publishable_refill_cycle.sql");
    expect(startSource).toContain(
      "0056_backlink_gmail_affected_project_count.sql",
    );
    expect(startSource).toContain("0057_backlink_resource_library.sql");
    expect(startSource).toContain(
      "0058_backlink_refill_reassessment_cursors.sql",
    );
    expect(startSource).toContain(
      "0059_backlink_recommendation_pool_generations.sql",
    );
    expect(startSource).toContain(
      "0060_backlink_v3_exact_ten_project_context.sql",
    );
    expect(statusSource).toContain(
      "$backlinkPublishableRefillCycleGateReady.Trim()",
    );
    expect(statusSource).toContain("$backlinkResourceLibraryGateReady.Trim()");
    expect(statusSource).toContain(
      "$backlinkReassessmentCursorGateReady.Trim()",
    );
    expect(statusSource).toContain("$backlinkVisiblePoolGateReady.Trim()");
    expect(statusSource).toContain(
      "$backlinkExactTenProjectContextGateReady.Trim()",
    );
    expect(startSource).toContain(
      "provider_inventory_requires_pin_or_management",
    );
    expect(startSource).toContain("backlink_commercial_discovery_blueprints");
    expect(startSource).toContain("backlink_commercial_inventory_policies");
    expect(startSource).toContain("backlink_contact_enrichment_batches");
    expect(startSource).toContain("backlink_contact_evidence_snapshots");
    expect(startSource).toContain("backlink_list_active_project_scopes");
    expect(startSource).toContain(
      "platform.backlink_list_active_website_projects",
    );
    expect(startSource).toContain("target_urls");
    expect(startSource).toContain("website_project_id");
    expect(startSource).toContain("source_contact_candidate_id");
    expect(startSource).toContain("contact_review_required");
    expect(startSource).toContain("backlink_website_project_mailbox_bindings");
    expect(startSource).toContain("backlink_draft_request_snapshots");
    expect(startSource).toContain("backlink_draft_request_snapshot_immutable");
    expect(startSource).toContain("RETRY_SCHEDULED");
    expect(startSource).toContain("TEMPLATE_FALLBACK");
    expect(startSource).toContain("backlink_gmail_connection_sync_cursors");
    expect(startSource).toContain("backlink_profile_sync_jobs");
    expect(startSource).toContain("backlink_profile_snapshots");
    expect(startSource).toContain("backlink_inventory_items");
    expect(startSource).toContain("approval_fact_id");
  });

  it("keeps one stable Gmail callback when projects are added or switched", () => {
    const stableCallback =
      "$publicBaseUrl/api/v1/backlinks/gmail-connections/callback";
    expect(configurationSource).toContain(stableCallback);
    expect(initializeProjectSource).toContain(stableCallback);
    expect(initializeProjectSource).not.toContain(
      "$publicBaseUrl/api/v1/projects/$ProjectKey/",
    );
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
    expect(configurationSource).toContain('AI_PROVIDER_TIMEOUT_MS = "45000"');
    expect(configurationSource).toContain("GMAIL_ROLLING_24_HOUR_SEND_LIMIT");
    expect(configurationSource).toContain("GMAIL_MINIMUM_INTERVAL_SECONDS");
    expect(startSource).toContain('"AI_PROVIDER"');
    expect(startSource).toContain('"GMAIL_SEND"');
    expect(startSource).toContain('"GMAIL_SYNC"');
    expect(startSource).toContain("[switch]$EnableGmail");
    expect(startSource).toContain("Resolve-GmailCapabilityEnabled");
    expect(startSource).toContain(
      '$scriptBoundParameters.ContainsKey("EnableGmail")',
    );
    expect(startSource).toContain("GOOGLE_OAUTH_CLIENT_SECRET_REF");
    expect(startSource).toContain('"GOOGLE_OAUTH_CLIENT_SECRET"');
    expect(startSource).toContain('"GMAIL_SEND_ENABLED"');
    expect(startSource).toContain('"GMAIL_SYNC_ENABLED"');
    expect(startSource).toContain('$env:NODE_ENV -eq "test"');
    expect(startSource).toContain('"LOCAL_PRODUCT_GMAIL_CONFIG_REQUIRED:"');
    expect(startSource).toContain("gmailPollingIntervalSeconds");
    expect(startSource).toContain("$contactReconciliationSql");
    expect(startSource).toContain("o.contact_review_required=false");
    expect(startSource).toContain("backlink_gmail_workspace_bindings");
    expect(startSource).toContain(
      "backlink_website_project_mailbox_bindings project_binding",
    );
    expect(startSource).toContain("project_binding.is_selected=true");
    expect(startSource).toContain("platform.projects project");
    expect(startSource).toContain("$gmailSyncWorkflows");
    expect(startSource).toContain("$gmailSyncFailures");
    expect(startSource).toContain("other project bindings will continue");
    expect(startSource).not.toContain("$gmailBindingSql");
    expect(startSource).not.toContain("current_usable AS");
  });

  it("restarts with the previous provider controls unless overridden", () => {
    expect(restartSource).toContain("local-product-processes.json");
    expect(restartSource).toContain("Resolve-SwitchValue");
    expect(restartSource).toContain("Resolve-IntegerValue");
    expect(restartSource).toContain(
      "-KeepInfrastructure:(-not $RestartInfrastructure)",
    );
    expect(restartSource).toContain('"Start-GrowthOS-LocalProduct.ps1"');
    expect(restartSource).toContain("$previousState.dataForSeoEnabled");
    expect(restartSource).toContain("$previousState.gmailSendEnabled");
    expect(restartSource).toContain("$previousState.gmailSyncEnabled");
    expect(restartSource).toContain(
      "$previousState.gmailPollingIntervalSeconds",
    );
  });

  it("uses the canonical generic backlink job success status", () => {
    expect(backlinkProfileRuntimeSource).toContain(
      "SET status='success',step=$5,progress=100,error=NULL",
    );
    expect(backlinkProfileRuntimeSource).not.toContain(
      "SET status='succeeded',step=$5,progress=100,error=NULL",
    );
    expect(backlinkProfileRuntimeSource).toContain(
      "summary.providerTaskId ?? input.profileSyncJobId",
    );
    expect(backlinkProfileRuntimeSource).toContain(
      "inventory.providerTaskId ?? input.profileSyncJobId",
    );
  });

  it("serializes backlink profile provider reservations on the current budget", () => {
    expect(backlinkProfileRuntimeSource).toContain(
      "ORDER BY period_start DESC",
    );
    expect(backlinkProfileRuntimeSource).toContain(
      "LIMIT 1\n       FOR UPDATE",
    );
    expect(backlinkProfileRuntimeSource).toContain(
      "AND budget_id=$4",
    );
    expect(backlinkProfileRuntimeSource).toContain(
      "numeric(gateRow.paidCallCount) + 2 > configuration.maxPaidCalls",
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
    expect(dataForSeoImportSource).not.toContain("DiscoveryTargets");
    expect(dataForSeoImportSource).toContain(
      "-CredentialSecretReference $CredentialSecretReference",
    );
    expect(dataForSeoImportSource).toContain("-MaxPaidCalls $MaxPaidCalls");
    expect(dataForSeoImportSource).toContain("-Keywords $Keywords");
    expect(dataForSeoImportSource).toContain("-Products $Products");
    expect(dataForSeoImportSource).toContain("-TargetUrls $TargetUrls");
  });
});
