[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProviderRequestId,
    [Parameter(Mandatory = $false)]
    [switch]$AssumeChargedAtReservation,
    [Parameter(Mandatory = $false)]
    [switch]$AssumeNotDispatched,
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$Database = "growthos_live001"
)

$ErrorActionPreference = "Stop"

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_INPUT_MISSING:$Name"
    }
    return ([string]$Value).Trim()
}

if (
    [int]$AssumeChargedAtReservation.IsPresent +
        [int]$AssumeNotDispatched.IsPresent -ne 1
) {
    throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_RESOLUTION_REQUIRED"
}
$parsedProviderRequestId = [guid]::Empty
if (
    -not [guid]::TryParse($ProviderRequestId, [ref]$parsedProviderRequestId)
) {
    throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_REQUEST_ID_INVALID"
}
$normalizedProviderRequestId = $parsedProviderRequestId.ToString()

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
        throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_IDENTITY_INVALID"
    }
}

$containerHealth = docker inspect --format `
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
    $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerHealth -ne "healthy") {
    throw "LOCAL_PRODUCT_POSTGRES_NOT_HEALTHY"
}

$assumeCharged = if ($AssumeChargedAtReservation) { "true" } else { "false" }
$failureCode = if ($AssumeChargedAtReservation) {
    "DATAFORSEO_RECONCILED_ASSUMED_CHARGE_NO_RESULT"
}
else {
    "DATAFORSEO_RECONCILED_NOT_DISPATCHED"
}
$resolution = if ($AssumeChargedAtReservation) {
    "assumed_charged_at_reservation_no_provider_result"
}
else {
    "confirmed_not_dispatched_reservation_released"
}
$sql = @"
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended(
    '${workspaceId}:dataforseo:reconcile:${normalizedProviderRequestId}',
    0
  )
);
CREATE TEMP TABLE local_product_dataforseo_reconciliation_result (
  action text NOT NULL,
  request_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  reconciled_cost_micros bigint NOT NULL,
  request_kind text NOT NULL
) ON COMMIT DROP;
DO `$reconcile`$
DECLARE
  batch backlinks.provider_batch_requests%ROWTYPE;
  request_row backlinks.backlink_provider_requests%ROWTYPE;
  ledger backlinks.backlink_provider_usage_ledger%ROWTYPE;
  budget backlinks.backlink_provider_budgets%ROWTYPE;
  lease backlinks.provider_fetch_leases%ROWTYPE;
  profile_job backlinks.backlink_profile_sync_jobs%ROWTYPE;
  request_kind text;
  reconciled_at timestamptz := clock_timestamp();
BEGIN
  SELECT *
    INTO request_row
    FROM backlinks.backlink_provider_requests
   WHERE id='$normalizedProviderRequestId'::uuid
     AND organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
     AND provider='dataforseo'
   FOR UPDATE;
  IF request_row.id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_REQUEST_MISSING';
  END IF;
  SELECT *
    INTO batch
    FROM backlinks.provider_batch_requests
   WHERE id=request_row.id
   FOR UPDATE;
  SELECT *
    INTO ledger
    FROM backlinks.backlink_provider_usage_ledger
   WHERE provider_request_id=request_row.id
   FOR UPDATE;
  IF ledger.id IS NULL THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_LEDGER_MISSING';
  END IF;
  SELECT *
    INTO budget
    FROM backlinks.backlink_provider_budgets
   WHERE id=ledger.budget_id
   FOR UPDATE;
  SELECT *
    INTO lease
    FROM backlinks.provider_fetch_leases
   WHERE owner_request_id=batch.request_id
   FOR UPDATE;

  IF batch.id IS NOT NULL THEN
    request_kind := 'commercial';
  ELSE
    IF request_row.active_request_bucket !~
      '^backlink-profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
    THEN
      RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_REQUEST_UNSUPPORTED';
    END IF;
    SELECT *
      INTO profile_job
      FROM backlinks.backlink_profile_sync_jobs
     WHERE id=split_part(request_row.active_request_bucket,':',2)::uuid
       AND organization_id=request_row.organization_id
       AND workspace_id=request_row.workspace_id
       AND website_project_id=request_row.website_project_id
     FOR UPDATE;
    IF profile_job.id IS NULL THEN
      RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_PROFILE_JOB_MISSING';
    END IF;
    request_kind := 'profile';
  END IF;

  IF request_row.status='failed'
    AND (
      (
        $assumeCharged
        AND ledger.status='settled'
        AND ledger.actual_cost_micros=ledger.estimated_cost_micros
        AND (
          request_kind='profile'
          OR (
            request_kind='commercial'
            AND batch.status='failed'
            AND batch.failure_code='$failureCode'
            AND lease.status='failed'
            AND lease.failure_code='$failureCode'
          )
        )
      )
      OR (
        NOT $assumeCharged
        AND request_kind='profile'
        AND ledger.status='released'
      )
    )
  THEN
    INSERT INTO local_product_dataforseo_reconciliation_result
    VALUES (
      'reused',request_row.id,ledger.budget_id,
      CASE WHEN $assumeCharged THEN ledger.actual_cost_micros ELSE 0 END,
      request_kind
    );
    RETURN;
  END IF;
  IF NOT $assumeCharged AND request_kind<>'profile' THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_RELEASE_UNSUPPORTED';
  END IF;
  IF ledger.status<>'reserved'
    OR (
      request_kind='commercial'
      AND NOT (
        (
          batch.status='unknown_charge'
          AND request_row.status='unknown_charge'
          AND lease.status='unknown_charge'
        )
        OR (
          $assumeCharged
          AND batch.status='running'
          AND request_row.status='running'
          AND lease.status='acquired'
          AND lease.lease_expires_at<=reconciled_at
        )
      )
    )
    OR (
      request_kind='profile'
      AND (
        request_row.status NOT IN ('running','unknown_charge')
        OR profile_job.status NOT IN ('running','failed')
      )
    )
  THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_STATE_INVALID';
  END IF;
  IF budget.id IS NULL OR budget.reserved_micros<ledger.estimated_cost_micros
  THEN
    RAISE EXCEPTION 'LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_BUDGET_INVALID';
  END IF;

  IF $assumeCharged THEN
    UPDATE backlinks.backlink_provider_usage_ledger
       SET status='settled',
           actual_cost_micros=estimated_cost_micros,
           settled_at=reconciled_at
     WHERE id=ledger.id;
    UPDATE backlinks.backlink_provider_budgets
       SET reserved_micros=reserved_micros-ledger.estimated_cost_micros,
           spent_micros=spent_micros+ledger.estimated_cost_micros,
           version=version+1
     WHERE id=budget.id;
  ELSE
    UPDATE backlinks.backlink_provider_usage_ledger
       SET status='released',released_at=reconciled_at
     WHERE id=ledger.id;
    UPDATE backlinks.backlink_provider_budgets
       SET reserved_micros=reserved_micros-ledger.estimated_cost_micros,
           version=version+1
     WHERE id=budget.id;
  END IF;
  UPDATE backlinks.backlink_provider_requests
     SET status='failed',finished_at=reconciled_at
   WHERE id=request_row.id;
  IF request_kind='commercial' THEN
    UPDATE backlinks.provider_batch_requests
       SET status='failed',
           failure_code='$failureCode',
           failed_count=1,
           actual_cost_micros=estimated_cost_micros,
           result_summary=jsonb_build_array(jsonb_build_object(
             'itemKey',normalized_request_hash,
             'requestFingerprint',normalized_request_hash,
             'status','reconciled_assumed_charge_no_result',
             'allocatedCostMicros',estimated_cost_micros
           )),
           finished_at=reconciled_at
     WHERE id=batch.id;
    UPDATE backlinks.provider_fetch_leases
       SET status='failed',
           failure_code='$failureCode',
           heartbeat_at=reconciled_at,
           lease_expires_at=reconciled_at,
           updated_at=reconciled_at
     WHERE artifact_fingerprint=lease.artifact_fingerprint;
  ELSE
    UPDATE backlinks.backlink_profile_sync_jobs
       SET status='failed',error_code='$failureCode',
           finished_at=reconciled_at,updated_at=reconciled_at,
           version=version+1
     WHERE id=profile_job.id;
    UPDATE backlinks.backlink_jobs
       SET status='failed',step='provider_result_reconciliation',
           progress=100,
           error=jsonb_build_object('code','$failureCode'::text),
           finished_at=reconciled_at,updated_at=reconciled_at,
           version=version+1
     WHERE id=profile_job.backlink_job_id;
  END IF;
  INSERT INTO local_product_dataforseo_reconciliation_result
  VALUES (
    'reconciled',request_row.id,ledger.budget_id,
    CASE WHEN $assumeCharged THEN ledger.estimated_cost_micros ELSE 0 END,
    request_kind
  );
END
`$reconcile`$;
SELECT json_build_object(
  'action',result.action,
  'requestKind',result.request_kind,
  'providerRequestIdMasked',
    left(result.request_id::text,8)||'...'||
      right(result.request_id::text,4),
  'budgetIdMasked',
    left(result.budget_id::text,8)||'...'||
      right(result.budget_id::text,4),
  'resolution','$resolution',
  'reconciledCostMicros',result.reconciled_cost_micros,
  'ledgerStatus',ledger.status,
  'providerRequestStatus',request.status,
  'providerBatchStatus',COALESCE(batch.status,'not_applicable'),
  'providerBatchFailureCode',batch.failure_code,
  'leaseStatus',COALESCE(lease.status,'not_applicable'),
  'budgetSpentMicros',budget.spent_micros,
  'budgetReservedMicros',budget.reserved_micros,
  'historicalLedgerEntries',(
    SELECT count(*)
      FROM backlinks.backlink_provider_usage_ledger
     WHERE organization_id='$organizationId'::uuid
       AND workspace_id='$workspaceId'::uuid
       AND provider='dataforseo'
  ),
  'officialAccountBalanceQueried',false
)::text
  FROM local_product_dataforseo_reconciliation_result result
  JOIN backlinks.backlink_provider_usage_ledger ledger
    ON ledger.provider_request_id=result.request_id
  JOIN backlinks.backlink_provider_requests request
    ON request.id=result.request_id
  LEFT JOIN backlinks.provider_batch_requests batch
    ON batch.id=result.request_id
  JOIN backlinks.backlink_provider_budgets budget
    ON budget.id=result.budget_id
  LEFT JOIN backlinks.provider_fetch_leases lease
    ON lease.owner_request_id=batch.request_id;
COMMIT;
"@

$output = @(
    $sql | docker exec -i $PostgresContainer `
        psql -X -q -v ON_ERROR_STOP=1 -U postgres -d $Database -At
)
if ($LASTEXITCODE -ne 0) {
    throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_FAILED"
}
$result = $output |
    Where-Object { ([string]$_).Trim().StartsWith("{") } |
    Select-Object -Last 1
if ([string]::IsNullOrWhiteSpace([string]$result)) {
    throw "LOCAL_PRODUCT_DATAFORSEO_RECONCILIATION_RESULT_MISSING"
}
Write-Output ([string]$result).Trim()
