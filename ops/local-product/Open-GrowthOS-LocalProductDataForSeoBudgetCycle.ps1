[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$Database = "growthos_live001",
    [ValidateRange(1, 100000000)]
    [int64]$ApprovedLimitMicros = 1000000,
    [ValidateRange(1, 1000)]
    [int]$MaxPaidCalls = 250
)

$ErrorActionPreference = "Stop"

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_INPUT_MISSING:$Name"
    }
    return ([string]$Value).Trim()
}

function Read-EnvironmentFile([string]$Path) {
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "LOCAL_PRODUCT_DATAFORSEO_ENVIRONMENT_MISSING"
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        if ($parts.Length -ne 2 -or $parts[0].Trim().Length -eq 0) {
            throw "LOCAL_PRODUCT_DATAFORSEO_ENVIRONMENT_INVALID"
        }
        $values[$parts[0].Trim()] = $parts[1]
    }
    return $values
}

function Write-Utf8File([string]$Path, [string[]]$Lines) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllLines(
        $temporaryPath,
        $Lines,
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-EnvironmentFile(
    [string]$Path,
    [System.Collections.IDictionary]$Values
) {
    Write-Utf8File $Path @(
        foreach ($entry in $Values.GetEnumerator()) {
            "$($entry.Key)=$($entry.Value)"
        }
    )
}

function Require-PositiveInt64($Value, [string]$Name) {
    $parsed = 0L
    if (
        -not [int64]::TryParse([string]$Value, [ref]$parsed) -or
        $parsed -le 0
    ) {
        throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_INVALID:$Name"
    }
    return $parsed
}

function Set-ObjectProperty(
    [object]$Target,
    [string]$Name,
    [object]$Value
) {
    if ($null -eq $Target.PSObject.Properties[$Name]) {
        $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
    else {
        $Target.$Name = $Value
    }
}

function Mask-SecretReference([string]$Reference) {
    if (
        $Reference -match (
            "^secret://growthos/local-product/dataforseo/.+/" +
            "(v[1-9][0-9]*)$"
        )
    ) {
        return "secret://growthos/local-product/dataforseo/***/$($Matches[1])"
    }
    throw "LOCAL_PRODUCT_DATAFORSEO_SECRET_REFERENCE_INVALID"
}

$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
}
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$organizationId = Require-Text `
    $identity.organizationId "identity.organizationId"
$workspaceId = Require-Text $identity.workspaceId "identity.workspaceId"
foreach ($value in @($organizationId, $workspaceId)) {
    if ($value -notmatch "^[0-9a-fA-F-]{36}$") {
        throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_IDENTITY_INVALID"
    }
}

$apiEnvironmentPath = Join-Path $RuntimeRoot "backlinks-api.env"
$workerEnvironmentPath = Join-Path $RuntimeRoot "backlinks-worker.env"
$apiEnvironment = Read-EnvironmentFile $apiEnvironmentPath
$workerEnvironment = Read-EnvironmentFile $workerEnvironmentPath
$estimatedCostMicros = Require-PositiveInt64 `
    $workerEnvironment["DATAFORSEO_ESTIMATED_COST_MICROS"] `
    "DATAFORSEO_ESTIMATED_COST_MICROS"
if ($ApprovedLimitMicros -lt $estimatedCostMicros) {
    throw "LOCAL_PRODUCT_DATAFORSEO_APPROVED_LIMIT_TOO_LOW"
}
foreach ($environment in @($apiEnvironment, $workerEnvironment)) {
    if ($environment["DATAFORSEO_ENABLED"] -ne "true") {
        throw "LOCAL_PRODUCT_DATAFORSEO_RUNTIME_NOT_ENABLED"
    }
}
$secretReference = Require-Text `
    $workerEnvironment["DATAFORSEO_CREDENTIAL_SECRET_REF"] `
    "DATAFORSEO_CREDENTIAL_SECRET_REF"
if (
    $apiEnvironment["DATAFORSEO_CREDENTIAL_SECRET_REF"] -ne $secretReference
) {
    throw "LOCAL_PRODUCT_DATAFORSEO_SECRET_REFERENCE_MISMATCH"
}
$maskedSecretReference = Mask-SecretReference $secretReference

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "LOCAL_PRODUCT_DATAFORSEO_MANIFEST_MISSING"
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
if ($null -eq $manifest.dataForSeo) {
    throw "LOCAL_PRODUCT_DATAFORSEO_MANIFEST_CONFIGURATION_MISSING"
}
if (
    (Require-Text $manifest.dataForSeo.credentialSecretRef `
        "manifest.dataForSeo.credentialSecretRef") -ne $secretReference
) {
    throw "LOCAL_PRODUCT_DATAFORSEO_MANIFEST_SECRET_REFERENCE_MISMATCH"
}

$statePath = Join-Path $RuntimeRoot "local-product-processes.json"
$state = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
else {
    $null
}

$containerHealth = docker inspect --format `
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
    $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerHealth -ne "healthy") {
    throw "LOCAL_PRODUCT_POSTGRES_NOT_HEALTHY"
}

$sql = @"
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('${workspaceId}:dataforseo:budget-cycle',0)
);
CREATE TEMP TABLE local_product_dataforseo_budget_cycle_result (
  action text NOT NULL,
  previous_budget_id uuid NOT NULL,
  previous_limit_micros bigint NOT NULL,
  previous_spent_micros bigint NOT NULL,
  previous_reserved_micros bigint NOT NULL,
  previous_paid_call_count bigint NOT NULL,
  current_budget_id uuid NOT NULL
) ON COMMIT DROP;
DO `$budget_cycle`$
DECLARE
  current_budget backlinks.backlink_provider_budgets%ROWTYPE;
  opened_budget backlinks.backlink_provider_budgets%ROWTYPE;
  current_remaining bigint;
  current_paid_call_count bigint;
  period_duration interval;
  cycle_start timestamptz;
BEGIN
  SELECT *
    INTO current_budget
    FROM backlinks.backlink_provider_budgets
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
     AND provider='dataforseo'
   ORDER BY period_start DESC
   LIMIT 1
   FOR UPDATE;
  IF current_budget.id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_APPROVED_BUDGET_MISSING';
  END IF;
  IF current_budget.reserved_micros <> 0 THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_BUDGET_RESERVATION_ACTIVE';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM backlinks.provider_batch_requests
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND provider='dataforseo'
       AND status='unknown_charge'
  ) THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_CHARGE_RECONCILIATION_REQUIRED';
  END IF;
  current_remaining := GREATEST(
    current_budget.limit_micros-current_budget.spent_micros
      -current_budget.reserved_micros,
    0
  );
  SELECT count(*)
    INTO current_paid_call_count
    FROM backlinks.backlink_provider_usage_ledger
   WHERE budget_id=current_budget.id
     AND status IN ('reserved','settled');
  IF (
    current_budget.period_start <= now()
    AND current_budget.period_end > now()
    AND current_budget.limit_micros = $ApprovedLimitMicros
    AND current_remaining >= $estimatedCostMicros
    AND current_paid_call_count < $MaxPaidCalls
  ) THEN
    INSERT INTO local_product_dataforseo_budget_cycle_result
    VALUES (
      'reused',current_budget.id,current_budget.limit_micros,
      current_budget.spent_micros,current_budget.reserved_micros,
      current_paid_call_count,
      current_budget.id
    );
  ELSE
    cycle_start := clock_timestamp();
    period_duration := current_budget.period_end-current_budget.period_start;
    IF period_duration <= interval '0 seconds' THEN
      RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_BUDGET_PERIOD_INVALID';
    END IF;
    IF current_budget.period_end > cycle_start THEN
      UPDATE backlinks.backlink_provider_budgets
         SET period_end=cycle_start,version=version+1
       WHERE id=current_budget.id
         AND organization_id=current_budget.organization_id
         AND workspace_id=current_budget.workspace_id;
    END IF;
    INSERT INTO backlinks.backlink_provider_budgets (
      id,organization_id,workspace_id,provider,period_start,period_end,
      limit_micros,spent_micros,reserved_micros,version,created_by
    ) VALUES (
      gen_random_uuid(),current_budget.organization_id,
      current_budget.workspace_id,'dataforseo',cycle_start,
      cycle_start+period_duration,$ApprovedLimitMicros,0,0,1,
      'local-product-budget-cycle'
    )
    RETURNING * INTO opened_budget;
    INSERT INTO local_product_dataforseo_budget_cycle_result
    VALUES (
      'opened',current_budget.id,current_budget.limit_micros,
      current_budget.spent_micros,current_budget.reserved_micros,
      current_paid_call_count,
      opened_budget.id
    );
  END IF;
END
`$budget_cycle`$;
SELECT json_build_object(
  'action',cycle.action,
  'previousBudgetIdMasked',
    left(cycle.previous_budget_id::text,8)||'...'||
      right(cycle.previous_budget_id::text,4),
  'previousLimitMicros',cycle.previous_limit_micros,
  'previousSpentMicros',cycle.previous_spent_micros,
  'previousReservedMicros',cycle.previous_reserved_micros,
  'previousPaidCallCount',cycle.previous_paid_call_count,
  'currentBudgetIdMasked',
    left(current_budget.id::text,8)||'...'||
      right(current_budget.id::text,4),
  'currentLimitMicros',current_budget.limit_micros,
  'currentSpentMicros',current_budget.spent_micros,
  'currentReservedMicros',current_budget.reserved_micros,
  'currentPaidCallCount',(
    SELECT count(*)
      FROM backlinks.backlink_provider_usage_ledger
     WHERE budget_id=current_budget.id
       AND status IN ('reserved','settled')
  ),
  'currentRemainingMicros',GREATEST(
    current_budget.limit_micros-current_budget.spent_micros
      -current_budget.reserved_micros,
    0
  ),
  'estimatedCostMicros',$estimatedCostMicros,
  'historicalBudgetPeriods',(
    SELECT count(*)
      FROM backlinks.backlink_provider_budgets
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND provider='dataforseo'
  ),
  'historicalLedgerEntries',(
    SELECT count(*)
      FROM backlinks.backlink_provider_usage_ledger
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND provider='dataforseo'
  ),
  'historicalSettledMicros',(
    SELECT coalesce(sum(actual_cost_micros),0)
      FROM backlinks.backlink_provider_usage_ledger
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND provider='dataforseo'
       AND status='settled'
  )
)::text
  FROM local_product_dataforseo_budget_cycle_result cycle
  JOIN backlinks.backlink_provider_budgets current_budget
    ON current_budget.id=cycle.current_budget_id;
COMMIT;
"@

$output = @(
    $sql | docker exec -i $PostgresContainer `
        psql -X -q -v ON_ERROR_STOP=1 -U postgres -d $Database -At
)
if ($LASTEXITCODE -ne 0) {
    throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_CYCLE_FAILED"
}
$resultJson = $output |
    Where-Object { ([string]$_).Trim().StartsWith("{") } |
    Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace([string]$resultJson)) {
    throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_CYCLE_RESULT_MISSING"
}

foreach ($environment in @($apiEnvironment, $workerEnvironment)) {
    $environment["DATAFORSEO_ABSOLUTE_BUDGET_MICROS"] = `
        [string]$ApprovedLimitMicros
    $environment["DATAFORSEO_MAX_PAID_CALLS"] = [string]$MaxPaidCalls
}
Set-ObjectProperty $manifest.dataForSeo `
    "absoluteBudgetMicros" $ApprovedLimitMicros
Set-ObjectProperty $manifest.dataForSeo `
    "absoluteBudget" ([decimal]$ApprovedLimitMicros / 1000000)
Set-ObjectProperty $manifest.dataForSeo "maxCalls" $MaxPaidCalls
Set-ObjectProperty $manifest.dataForSeo `
    "maxProviderRequests" $MaxPaidCalls
if ($null -ne $state) {
    Set-ObjectProperty $state "dataForSeoEnabled" $true
    Set-ObjectProperty $state "dataForSeoMaxPaidCalls" $MaxPaidCalls
}

Write-EnvironmentFile $apiEnvironmentPath $apiEnvironment
Write-EnvironmentFile $workerEnvironmentPath $workerEnvironment
Write-Utf8File $ManifestPath @($manifest | ConvertTo-Json -Depth 16)
if ($null -ne $state) {
    Write-Utf8File $statePath @($state | ConvertTo-Json -Depth 16)
}

$result = [ordered]@{}
foreach (
    $property in (
        ([string]$resultJson).Trim() | ConvertFrom-Json
    ).PSObject.Properties
) {
    $result[$property.Name] = $property.Value
}
$result["approvedLimitMicros"] = $ApprovedLimitMicros
$result["maxPaidCalls"] = $MaxPaidCalls
$result["runtimeConfigurationUpdated"] = $true
$result["secretReferenceMasked"] = $maskedSecretReference
$result["officialAccountBalanceQueried"] = $false
Write-Output ($result | ConvertTo-Json -Compress)
