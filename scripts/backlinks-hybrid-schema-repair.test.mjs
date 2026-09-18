import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const devUp = fileURLToPath(new URL("./dev-up.ps1", import.meta.url));
const renderer = fileURLToPath(new URL(
  "../backend/core/scripts/render-backlinks-deployment-manifest.mjs",
  import.meta.url,
));
const source = await readFile(devUp, "utf8");

function probe(state, { failWrite = false, incomplete = false } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:TEST_DEV_UP, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Parse failed' }
foreach ($name in @('Invoke-BacklinksMigrations', 'Repair-BacklinksHybridSchemaGap')) {
  $fn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq $name
  }, $true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
$backlinksDeploymentManifestRenderer = $env:TEST_RENDERER
$script:state = '${state}'
$script:writes = 0
$script:reads = 0
function Invoke-PostgresScalar {
  param([string]$Sql)
  $script:reads++
  if (-not $Sql.Contains('backlink_project_domain_ratings') -or
      -not $Sql.Contains('resource_library_snapshot')) { throw 'Incomplete probe' }
  return $script:state
}
function Invoke-PostgresSql {
  param([string]$Sql)
  $script:writes++
  if (-not $Sql.Contains('CREATE TABLE backlink_project_domain_ratings') -or
      $Sql.Contains('ALTER TABLE backlink_recommendation_release_batch_items')) {
    throw 'Must apply only manifest-verified 0099'
  }
  if ($env:TEST_FAIL_WRITE -eq 'true') { throw 'database rejected migration' }
  if ($env:TEST_INCOMPLETE -ne 'true') { $script:state = 'ready' }
}
$failure = $null
try {
  Repair-BacklinksHybridSchemaGap
  Repair-BacklinksHybridSchemaGap
} catch { $failure = $_.Exception.Message }
@{ writes=$script:writes; reads=$script:reads; state=$script:state; failure=$failure } |
  ConvertTo-Json -Compress
`;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_DEV_UP: devUp,
      TEST_RENDERER: renderer,
      TEST_FAIL_WRITE: String(failWrite),
      TEST_INCOMPLETE: String(incomplete),
    },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}

test("startup repairs dependency gaps before inferring the highest migration", () => {
  const invocation = source.indexOf("\n    Repair-BacklinksHybridSchemaGap\n");
  assert.ok(invocation > 0 && invocation < source.indexOf("$backlinksHead ="));
});

test("0100 without 0099 repairs only 0099 and the next check is a no-op", () => {
  assert.deepEqual(probe("missing-0099"), {
    writes: 1, reads: 3, state: "ready", failure: null,
  });
});

for (const state of ["ready", "before-hybrid"]) {
  test(`${state} leaves existing or pristine schemas for the normal migration path`, () => {
    assert.deepEqual(probe(state), { writes: 0, reads: 2, state, failure: null });
  });
}

test("a failed migration stops startup instead of trusting 0100", () => {
  const result = probe("missing-0099", { failWrite: true });
  assert.equal(result.writes, 1);
  assert.match(result.failure, /database rejected migration/u);
});

test("a repair must be verified before startup continues", () => {
  assert.match(probe("missing-0099", { incomplete: true }).failure,
    /BACKLINKS_SCHEMA_REPAIR_INCOMPLETE/u);
});

test("an unknown probe result fails closed", () => {
  const result = probe("unexpected");
  assert.equal(result.writes, 0);
  assert.equal(result.failure, "BACKLINKS_SCHEMA_UNKNOWN_HYBRID_STATE");
});
