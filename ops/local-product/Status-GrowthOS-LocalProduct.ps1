param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path,
    [switch]$Json,
    [switch]$NoFail
)

$ErrorActionPreference = "Stop"
$statePath = Join-Path $RuntimeRoot "local-product-processes.json"
$state = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
else {
    $null
}
$identityPath = Join-Path $RuntimeRoot "identity.json"
$identity = if (Test-Path -LiteralPath $identityPath) {
    Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
else {
    $null
}

function Get-HttpStatus([string]$Uri) {
    try {
        $response = Invoke-WebRequest `
            -Uri $Uri `
            -UseBasicParsing `
            -TimeoutSec 5
        return [int]$response.StatusCode
    }
    catch {
        return 0
    }
}

function Get-ContainerHealth([string]$Name) {
    $health = docker inspect `
        --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
        $Name 2>$null
    if ($LASTEXITCODE -ne 0) {
        return "missing"
    }
    return [string]$health
}

function Read-EnvironmentFile([string]$Path) {
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $values
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        if ($parts.Length -eq 2 -and $parts[0].Trim().Length -gt 0) {
            $values[$parts[0].Trim()] = $parts[1]
        }
    }
    return $values
}

function Get-EnvironmentBoolean(
    [System.Collections.IDictionary]$Values,
    [string]$Name
) {
    if (-not $Values.Contains($Name)) {
        return $false
    }
    return [string]$Values[$Name] -eq "true"
}

function Get-EnvironmentNumber(
    [System.Collections.IDictionary]$Values,
    [string]$Name
) {
    if (-not $Values.Contains($Name)) {
        return $null
    }
    $number = 0L
    if ([int64]::TryParse([string]$Values[$Name], [ref]$number)) {
        return $number
    }
    return $null
}

function Get-RecentErrorSummary(
    [string]$LogsRoot,
    [string]$RunId
) {
    if (
        [string]::IsNullOrWhiteSpace($RunId) `
        -or -not (Test-Path -LiteralPath $LogsRoot)
    ) {
        return @()
    }
    $patterns = [ordered]@{
        client_disconnect = "(?i)ClientDisconnect"
        fatal = "(?i)\bfatal\b"
        unhandled = "(?i)\bunhandled\b"
        exception = "(?i)\bexception\b"
        error = "(?i)\berror\b"
    }
    return @(
        Get-ChildItem `
            -LiteralPath $LogsRoot `
            -Filter "$RunId-*.stderr.log" `
            -File `
            -ErrorAction SilentlyContinue |
            ForEach-Object {
                $content = Get-Content `
                    -LiteralPath $_.FullName `
                    -Raw `
                    -Encoding UTF8 `
                    -ErrorAction SilentlyContinue
                $categories = @(
                    foreach ($pattern in $patterns.GetEnumerator()) {
                        if ($content -match $pattern.Value) {
                            $pattern.Key
                        }
                    }
                )
                if ($categories.Count -gt 0) {
                    $component = $_.BaseName -replace (
                        "^" + [regex]::Escape($RunId) + "-"
                    ), ""
                    $matchCount = 0
                    foreach ($pattern in $patterns.Values) {
                        $matchCount += [regex]::Matches(
                            $content,
                            $pattern
                        ).Count
                    }
                    [pscustomobject]@{
                        component = $component -replace "\.stderr$", ""
                        categories = $categories
                        matchCount = $matchCount
                        lastWriteTime = $_.LastWriteTime.ToString("o")
                    }
                }
            }
    )
}

$coreEnvironment = Read-EnvironmentFile (
    Join-Path $RuntimeRoot "backlinks-api.env"
)
$providerConfiguration = [pscustomobject]@{
    dataForSeo = [pscustomobject]@{
        enabled = Get-EnvironmentBoolean $coreEnvironment "DATAFORSEO_ENABLED"
        maxPaidCalls = Get-EnvironmentNumber `
            $coreEnvironment "DATAFORSEO_MAX_PAID_CALLS"
        estimatedCostMicros = Get-EnvironmentNumber `
            $coreEnvironment "DATAFORSEO_ESTIMATED_COST_MICROS"
        absoluteBudgetMicros = Get-EnvironmentNumber `
            $coreEnvironment "DATAFORSEO_ABSOLUTE_BUDGET_MICROS"
        candidateLimit = Get-EnvironmentNumber `
            $coreEnvironment "DATAFORSEO_CANDIDATE_LIMIT"
    }
    ai = [pscustomobject]@{
        enabled = Get-EnvironmentBoolean $coreEnvironment "AI_PROVIDER_ENABLED"
        maxCalls = Get-EnvironmentNumber $coreEnvironment "AI_PROVIDER_MAX_CALLS"
        absoluteBudgetUsd = if (
            $coreEnvironment.Contains("AI_PROVIDER_ABSOLUTE_BUDGET_USD")
        ) {
            [string]$coreEnvironment["AI_PROVIDER_ABSOLUTE_BUDGET_USD"]
        }
        else {
            $null
        }
    }
    gmail = [pscustomobject]@{
        sendEnabled = Get-EnvironmentBoolean `
            $coreEnvironment "GMAIL_SEND_ENABLED"
        syncEnabled = Get-EnvironmentBoolean `
            $coreEnvironment "GMAIL_SYNC_ENABLED"
        rolling24HourSendLimit = Get-EnvironmentNumber `
            $coreEnvironment "GMAIL_ROLLING_24_HOUR_SEND_LIMIT"
        minimumIntervalSeconds = Get-EnvironmentNumber `
            $coreEnvironment "GMAIL_MINIMUM_INTERVAL_SECONDS"
        pollingIntervalSeconds = Get-EnvironmentNumber `
            $coreEnvironment "GMAIL_POLLING_INTERVAL_SECONDS"
    }
    browser = [pscustomobject]@{
        enabled = Get-EnvironmentBoolean `
            $coreEnvironment "BROWSER_PROVIDER_ENABLED"
        workerTimeoutMs = Get-EnvironmentNumber `
            $coreEnvironment "BROWSER_WORKER_TIMEOUT_MS"
        maxPages = Get-EnvironmentNumber `
            $coreEnvironment "CONTACT_ENRICHMENT_MAX_PAGES"
        maxAttempts = Get-EnvironmentNumber `
            $coreEnvironment "CONTACT_ENRICHMENT_MAX_ATTEMPTS"
    }
}

$listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object LocalPort -In 5173, 7200, 7301, 7401, 55432, 57233, 59090 |
        Sort-Object LocalPort |
        ForEach-Object {
            [pscustomobject]@{
                address = $_.LocalAddress
                port = $_.LocalPort
                pid = $_.OwningProcess
            }
        }
)
$listenerPorts = @($listeners | ForEach-Object port)
$processes = [ordered]@{}
foreach ($entry in ([ordered]@{
    browser = if ($null -eq $state) { 0 } else { $state.browserGroupPid }
    coreApi = if ($null -eq $state) { 0 } else { $state.coreApiGroupPid }
    worker = if ($null -eq $state) { 0 } else { $state.workerGroupPid }
    fastApi = if ($null -eq $state) { 0 } else { $state.fastApiGroupPid }
    frontend = if ($null -eq $state) { 0 } else { $state.frontendGroupPid }
}).GetEnumerator()) {
    $pidValue = [uint32]$entry.Value
    $processes[$entry.Key] = [pscustomobject]@{
        groupPid = $pidValue
        running = (
            $pidValue -gt 0 `
            -and $null -ne (
                Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            )
        )
    }
}

$postgresHealth = Get-ContainerHealth "growthos-live001-postgres"
$temporalHealth = Get-ContainerHealth "growthos-live001-temporal"
$databaseFacts = $null
$databaseGovernance = $null
$databaseHead = $null
$backlinksHead = $null
if ($postgresHealth -eq "healthy") {
    $databaseHead = docker exec growthos-live001-postgres `
        psql -U postgres -d growthos_live001 -Atqc `
        "SELECT version_num FROM alembic_version LIMIT 1;"
    if ($LASTEXITCODE -eq 0 -and $null -ne $identity) {
        $organizationId = [guid]$identity.organizationId
        $workspaceId = [guid]$identity.workspaceId
        $websiteProjectId = [guid]$identity.websiteProjectId
        $databaseFactsJson = docker exec growthos-live001-postgres `
            psql -U postgres -d growthos_live001 -Atqc @"
SELECT json_build_object(
  'projects',(
    SELECT count(*) FROM platform.projects
     WHERE organization_id='$organizationId'
       AND id='$websiteProjectId'
  ),
  'projectContextSnapshots',(
    SELECT count(*) FROM backlinks.backlink_project_context_snapshots
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'recommendations',(
    SELECT count(*) FROM backlinks.backlink_recommendations
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'recommendationInventory',(
    SELECT count(*) FROM backlinks.backlink_recommendation_inventory
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'contactEnrichmentJobs',(
    SELECT count(*) FROM backlinks.backlink_contact_enrichment_jobs
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'contactEnrichmentPages',(
    SELECT count(*) FROM backlinks.backlink_contact_enrichment_pages
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'contactCandidates',(
    SELECT count(*) FROM backlinks.backlink_contact_candidates
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'contactEvidence',(
    SELECT count(*) FROM backlinks.backlink_contact_evidence
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'contacts',(
    SELECT count(*) FROM backlinks.backlink_contacts
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'opportunities',(
    SELECT count(*) FROM backlinks.backlink_opportunities
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'gmailConnections',(
    SELECT count(*)
      FROM backlinks.backlink_gmail_workspace_bindings
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
  ),
  'connectedGmailConnections',(
    SELECT count(*)
      FROM backlinks.backlink_gmail_workspace_bindings b
      JOIN backlinks.backlink_gmail_connections c
        ON (c.organization_id,c.id)=
           (b.organization_id,b.gmail_connection_id)
     WHERE b.organization_id='$organizationId'::uuid
       AND b.workspace_id='$workspaceId'::uuid
       AND b.binding_status='ACTIVE'
       AND c.connection_status='CONNECTED'
  ),
  'drafts',(
    SELECT count(*) FROM backlinks.backlink_email_drafts
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'draftVersions',(
    SELECT count(*) FROM backlinks.backlink_draft_versions
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'sendIntents',(
    SELECT count(*) FROM backlinks.backlink_send_intents
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'sendAttempts',(
    SELECT count(*) FROM backlinks.backlink_send_attempts
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'acceptedSendAttempts',(
    SELECT count(*) FROM backlinks.backlink_send_attempts
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
       AND status='PROVIDER_ACCEPTED'
  ),
  'sendSnapshots',(
    SELECT count(*) FROM backlinks.backlink_send_snapshots
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'mailSyncCursors',(
    SELECT count(*) FROM backlinks.backlink_mail_sync_cursors
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'mailThreads',(
    SELECT count(*) FROM backlinks.backlink_mail_threads
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'mailMessages',(
    SELECT count(*) FROM backlinks.backlink_mail_messages
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'placementCandidates',(
    SELECT count(*) FROM backlinks.backlink_placement_candidates
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'placementValidationRuns',(
    SELECT count(*) FROM backlinks.backlink_placement_validation_runs
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'placements',(
    SELECT count(*) FROM backlinks.backlink_placements
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'monitoringPolicies',(
    SELECT count(*) FROM backlinks.backlink_monitor_policies
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'monitoringRuns',(
    SELECT count(*) FROM backlinks.backlink_monitor_runs
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'monitoringObservations',(
    SELECT count(*) FROM backlinks.backlink_monitor_observations
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  ),
  'tasks',(
    SELECT count(*) FROM backlinks.backlink_task_projections
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND website_project_id='$websiteProjectId'::uuid
  )
)::text;
"@
        if ($LASTEXITCODE -eq 0 -and $databaseFactsJson) {
            $databaseFacts = $databaseFactsJson | ConvertFrom-Json
        }
        $databaseGovernanceJson = docker exec growthos-live001-postgres `
            psql -U postgres -d growthos_live001 -Atqc @"
WITH latest_switches AS (
  SELECT layer,capability,provider,blocked,version,reason,created_at,
         row_number() OVER (
           PARTITION BY layer,capability,provider
           ORDER BY version DESC
         ) AS rank
    FROM backlinks.backlink_kill_switch_versions
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
     AND website_project_id='$websiteProjectId'::uuid
),
ledger AS (
  SELECT provider,status,count(*)::integer AS entries,
         sum(estimated_cost_micros)::bigint AS estimated_micros,
         coalesce(sum(actual_cost_micros),0)::bigint AS actual_micros
    FROM backlinks.backlink_provider_usage_ledger
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
     AND website_project_id='$websiteProjectId'::uuid
   GROUP BY provider,status
)
SELECT json_build_object(
  'rlsReady',(
    SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='backlinks'
       AND c.relname IN (
         'backlink_provider_budgets',
         'backlink_provider_usage_ledger',
         'backlink_kill_switch_versions'
       )
  ),
  'budgets',coalesce((
    SELECT json_agg(json_build_object(
      'provider',provider,
      'periodStart',period_start,
      'periodEnd',period_end,
      'limitMicros',limit_micros,
      'spentMicros',spent_micros,
      'reservedMicros',reserved_micros,
      'remainingMicros',greatest(
        limit_micros-spent_micros-reserved_micros,
        0
      )
    ) ORDER BY provider,period_start DESC)
      FROM backlinks.backlink_provider_budgets
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND period_start<=now() AND period_end>now()
  ),'[]'::json),
  'usageLedger',coalesce((
    SELECT json_agg(row_to_json(ledger) ORDER BY provider,status)
      FROM ledger
  ),'[]'::json),
  'killSwitches',coalesce((
    SELECT json_agg(json_build_object(
      'layer',layer,
      'capability',capability,
      'provider',provider,
      'blocked',blocked,
      'version',version,
      'reason',reason,
      'createdAt',created_at
    ) ORDER BY layer,capability,provider)
      FROM latest_switches
     WHERE rank=1
  ),'[]'::json)
)::text;
"@
        if ($LASTEXITCODE -eq 0 -and $databaseGovernanceJson) {
            $databaseGovernance = $databaseGovernanceJson | ConvertFrom-Json
        }
        $opportunityContactGateReady = docker exec growthos-live001-postgres `
            psql -U postgres -d growthos_live001 -Atqc @"
SELECT (
  (SELECT count(*)
     FROM information_schema.columns
    WHERE table_schema='backlinks'
      AND table_name='backlink_opportunities'
      AND column_name IN (
        'source_contact_candidate_id',
        'contact_review_required'
      )) = 2
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_opportunities'::regclass
       AND conname='backlink_opportunity_source_contact_candidate_fk'
  )
)::text;
"@
        if ($LASTEXITCODE -eq 0) {
            $existingPlacementGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name IN (
         'backlink_placement_validation_runs',
         'backlink_placements'
       )
       AND column_name='opportunity_id'
       AND is_nullable='YES'
  ) = 2
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_placement_validation_runs'::regclass
       AND conname=
         'backlink_placement_validation_candidate_identity_fk'
  )
)::text;
"@
            $gmailProjectBindingGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT EXISTS (
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_gmail_workspace_bindings'
     AND column_name='website_project_id'
     AND is_nullable='NO'
)::text;
"@
            $projectRecommendationContextGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT ((
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_project_context_snapshots'
     AND column_name IN ('products','keywords','target_urls')
     AND data_type='jsonb'
     AND is_nullable='NO'
) = 3)::text;
"@
            $projectScopeProviderGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  to_regprocedure(
    'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_contact_enrichment_jobs'::regclass
       AND conname='backlink_contact_enrichment_job_status_check'
       AND position('stale_context' IN pg_get_constraintdef(oid)) > 0
  )
)::text;
"@
            $platformProjectAuthorityGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  to_regprocedure(
    'platform.backlink_list_active_website_projects(text,text)'
  ) IS NOT NULL
  AND position(
    'platform.backlink_list_active_website_projects' IN
    pg_get_functiondef(
      'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'::regprocedure
    )
  ) > 0
)::text;
"@
            $commercialCandidateInventoryGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  to_regclass(
    'backlinks.backlink_commercial_discovery_blueprints'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_discovery_batches'
  ) IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_candidates') IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_discovery_artifacts'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_inventory_policies'
  ) IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_gold_sets') IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_gold_labels') IS NOT NULL
)::text;
"@
            $contactPublicationGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  to_regclass(
    'backlinks.backlink_contact_enrichment_batches'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_contact_evidence_snapshots'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_contact_enrichment_jobs'
       AND column_name='terminal_reason_code'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_recommendation_inventory'
       AND column_name='contact_evidence_snapshot_id'
  )
)::text;
"@
            $gmailOrganizationReuseGateReady = docker exec `
                growthos-live001-postgres psql -U postgres `
                -d growthos_live001 -Atqc @"
SELECT (
  to_regclass(
    'backlinks.backlink_website_project_mailbox_bindings'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_gmail_workspace_bindings'
       AND column_name='website_project_id'
       AND is_nullable='YES'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid=
       'backlinks.backlink_website_project_mailbox_bindings'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
)::text;
"@
            $backlinksHead = if (
                $LASTEXITCODE -eq 0 `
                -and $gmailOrganizationReuseGateReady.Trim() -eq "true"
            ) {
                "0047"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $contactPublicationGateReady.Trim() -eq "true"
            ) {
                "0046"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $commercialCandidateInventoryGateReady.Trim() -eq "true"
            ) {
                "0045"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $platformProjectAuthorityGateReady.Trim() -eq "true"
            ) {
                "0044"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $projectScopeProviderGateReady.Trim() -eq "true"
            ) {
                "0043"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $projectRecommendationContextGateReady.Trim() -eq "true"
            ) {
                "0042"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $gmailProjectBindingGateReady.Trim() -eq "true"
            ) {
                "0041"
            }
            elseif (
                $LASTEXITCODE -eq 0 `
                -and $existingPlacementGateReady.Trim() -eq "true"
            ) {
                "0040"
            }
            elseif (
                $opportunityContactGateReady.Trim() -eq "true"
            ) {
                "0039"
            }
            elseif (
                docker exec growthos-live001-postgres psql -U postgres `
                    -d growthos_live001 -Atqc `
                    "SELECT to_regclass('backlinks.backlink_contact_enrichment_jobs') IS NOT NULL;" |
                    Select-String -SimpleMatch "t"
            ) {
                "0038"
            }
        }
    }
}

$temporalNamespaceReady = $false
if ($temporalHealth -eq "healthy") {
    docker exec growthos-live001-temporal temporal operator namespace describe `
        --namespace growthos-backlinks-canary `
        --address 127.0.0.1:7233 `
        --output json 2>$null | Out-Null
    $temporalNamespaceReady = $LASTEXITCODE -eq 0
}

$manifest = Get-Content `
    -LiteralPath (Join-Path $RepositoryRoot `
        "backend\database\deployment-manifest.v1.json") `
    -Raw `
    -Encoding UTF8 |
    ConvertFrom-Json
$coreStatus = Get-HttpStatus "http://127.0.0.1:7301/ready"
$fastApiStatus = Get-HttpStatus "http://127.0.0.1:7200/ready"
$frontendStatus = Get-HttpStatus "http://127.0.0.1:5173"
$browserStatus = Get-HttpStatus "http://127.0.0.1:7401/health"
$browserRequired = $null -ne $state -and $state.browserEnabled -eq $true
$recentErrors = @(
    Get-RecentErrorSummary `
        (Join-Path $RuntimeRoot "logs") `
        $(if ($null -eq $state) { $null } else { [string]$state.runId })
)
$healthy = (
    $null -ne $state `
    -and $processes.coreApi.running `
    -and $processes.worker.running `
    -and $processes.fastApi.running `
    -and $processes.frontend.running `
    -and (
        -not $browserRequired `
        -or (
            $processes.browser.running `
            -and $browserStatus -eq 200 `
            -and 7401 -in $listenerPorts
        )
    ) `
    -and $coreStatus -eq 200 `
    -and $fastApiStatus -eq 200 `
    -and $frontendStatus -eq 200 `
    -and $postgresHealth -eq "healthy" `
    -and $temporalHealth -eq "healthy" `
    -and $temporalNamespaceReady `
    -and $null -ne $databaseFacts `
    -and $null -ne $databaseGovernance `
    -and $databaseGovernance.rlsReady -eq $true `
    -and ([string]$databaseHead) -eq ([string]$manifest.heads.alembic) `
    -and ([string]$backlinksHead) -eq ([string]$manifest.heads.backlinks) `
    -and 5173 -in $listenerPorts `
    -and 7200 -in $listenerPorts `
    -and 7301 -in $listenerPorts `
    -and 55432 -in $listenerPorts `
    -and 57233 -in $listenerPorts
)

$result = [pscustomobject]@{
    status = if ($healthy) { "ok" } else { "not_ready" }
    checkedAt = Get-Date -Format o
    runtimeMode = if ($null -eq $state) { $null } else { $state.runtimeMode }
    runId = if ($null -eq $state) { $null } else { $state.runId }
    projectKey = if ($null -eq $state) { $null } else { $state.projectKey }
    providers = $providerConfiguration
    endpoints = [pscustomobject]@{
        browserWorker = [pscustomobject]@{
            url = "http://127.0.0.1:7401"
            statusCode = $browserStatus
            enabled = $browserRequired
        }
        frontend = [pscustomobject]@{
            url = "http://localhost:5173"
            statusCode = $frontendStatus
        }
        fastApi = [pscustomobject]@{
            url = "http://localhost:7200"
            statusCode = $fastApiStatus
        }
        privateCore = [pscustomobject]@{
            url = "http://127.0.0.1:7301"
            statusCode = $coreStatus
        }
    }
    processes = [pscustomobject]$processes
    listeners = $listeners
    recentErrors = $recentErrors
    postgres = [pscustomobject]@{
        container = "growthos-live001-postgres"
        health = $postgresHealth
        port = 55432
        requiredMajor = $manifest.postgresql.requiredMajor
        alembicHead = $databaseHead
        backlinksHead = $backlinksHead
        persistentFacts = $databaseFacts
        governance = $databaseGovernance
    }
    temporal = [pscustomobject]@{
        container = "growthos-live001-temporal"
        health = $temporalHealth
        port = 57233
        metricsPort = 59090
        namespace = "growthos-backlinks-canary"
        namespaceReady = $temporalNamespaceReady
    }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 12
}
else {
    $result
}
if (-not $healthy -and -not $NoFail) {
    exit 1
}
