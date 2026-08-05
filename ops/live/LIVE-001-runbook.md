# LIVE-001 Runbook

This runbook starts the GrowthOS public FastAPI gateway, private Backlinks
Core API, and Backlinks Temporal worker without enabling external providers.
It does not authorize production data, Gmail, DataForSEO, AI, or browser
provider access.

## Prerequisites

- PostgreSQL 18 is reachable through a `LOGIN`, `NOSUPERUSER`,
  `NOBYPASSRLS` application principal that is a member of
  `growthos_backlinks_writer`.
- The FastAPI database connection also uses a `LOGIN`, `NOSUPERUSER`,
  `NOBYPASSRLS` application principal with `row_security=on`.
- The platform and Backlinks migrations have already been applied by the
  database migration role.
- Temporal Server is reachable and the Canary namespace exists.
- Secret Store values are mounted as files. Environment variables contain
  only the corresponding secret references and file paths.
- `BACKLINKS_RUNTIME_MODULE` points to an approved production composition
  module. Test fixtures, fake adapters, and in-memory repositories are
  prohibited.
- The Core API and worker use separate environment files because their
  `BACKLINKS_API_ENABLED` and `BACKLINKS_WORKER_ENABLED` values are mutually
  exclusive.

## Local Persistent Canary

The checked LIVE-001 Canary uses:

- Compose file `deploy/live/docker-compose.live001.yml`
- external runtime root `%LOCALAPPDATA%\GrowthOS\live001`
- PostgreSQL host port `55432`
- Temporal host port `57233`
- Temporal namespace `growthos-backlinks-canary`

The external runtime root contains the generated secret files, identity
metadata, no-secret process environment files, logs, and transient PID state.
Do not copy those values into the repository.

Start or inspect the persistent infrastructure:

```powershell
$env:GROWTHOS_LIVE001_SECRET_DIR =
  "$env:LOCALAPPDATA\GrowthOS\live001\secrets"

docker compose `
  -f deploy\live\docker-compose.live001.yml `
  up -d

docker compose `
  -f deploy\live\docker-compose.live001.yml `
  ps
```

The PostgreSQL and Temporal named volumes are intentionally retained when the
three application processes stop.

## Build

```powershell
Set-Location backend\core
npm ci
npm run build

Set-Location ..\api
uv sync --frozen
```

## Migrations

Run migrations once as an explicit deployment step before starting any
application process. Do not run migrations from FastAPI, Core, or Worker
startup hooks.

```powershell
Set-Location backend\api
uv run alembic upgrade head
```

Apply the ordered Backlinks SQL migration manifest with the approved database
deployment command and migration role. Record the command, migration version,
database identifier, and exit code in the activation ledger.

## Start Order

1. Start or verify Temporal Server and the Canary namespace.
2. Start the private Backlinks Core API on loopback.
3. Start the Backlinks worker on `growthos.backlinks.v1`.
4. Start the public FastAPI gateway.

Load the approved no-secret environment values into each process before
running these commands:

```powershell
Set-Location backend\core
npm run start:api

# In a separate process with BACKLINKS_API_ENABLED=false and
# BACKLINKS_WORKER_ENABLED=true:
npm run start:worker

Set-Location ..\api
uv run python -m app.serve
```

For the local Windows Canary, the checked process-group launcher performs the
same order and writes logs/PID state outside the repository:

```powershell
.\ops\live\Start-Live001Canary.ps1
```

The Core process must use `BACKLINKS_HOST=127.0.0.1` or another explicitly
approved loopback deployment. The FastAPI process is the only public API.

## Readiness And Listener Checks

```powershell
Invoke-RestMethod http://127.0.0.1:7301/health
Invoke-RestMethod http://127.0.0.1:7301/ready
Invoke-RestMethod http://127.0.0.1:7200/health
Invoke-RestMethod http://127.0.0.1:7200/ready

Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -In 7200,7301 |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

`/health` proves only that the process is running. `/ready` must fail with
HTTP 503 unless PostgreSQL 18, the application-role/RLS contract, required
migrations, Temporal, and the private Core dependency are available. Port
`7301` must have zero public listeners.

## Stop And Restart

Send `CTRL+C`, `SIGINT`, or `SIGTERM` to each process. Stop the public gateway
first, then Core, then the worker. Core stops accepting requests before
closing its runtime resources. The worker requests Temporal shutdown and
waits for worker completion before closing database and Temporal clients.

For restart verification, repeat the start order and readiness checks. Do not
change provider switches during restart.

For the local Windows Canary:

```powershell
.\ops\live\Stop-Live001Canary.ps1
.\ops\live\Start-Live001Canary.ps1
```

The stop command sends `CTRL_BREAK` to each isolated process group and waits
for FastAPI application shutdown and Temporal Worker drain. It removes only
the transient PID state; it does not remove PostgreSQL or Temporal volumes.

## Required Disabled Capabilities

The following values must remain `false` for both Core and FastAPI:

```text
GMAIL_SEND_ENABLED
GMAIL_SYNC_ENABLED
DATAFORSEO_ENABLED
AI_PROVIDER_ENABLED
BROWSER_PROVIDER_ENABLED
```

Any missing required configuration, unreadable secret file, invalid queue,
non-loopback Core bind, superuser or `BYPASSRLS` database connection, failed
dependency check, or missing production runtime factory must terminate
startup. There is no fallback to a fake, mock, in-memory repository, or
alternate task queue.
