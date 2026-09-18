# Central provider response archive

## Local database quick start

The native Windows workflow can provision an isolated archive database inside
the existing local PostgreSQL instance. From the repository root:

```powershell
./scripts/provider-archive-local.ps1 -Action setup
./scripts/provider-archive-local.ps1 -Action start
./scripts/provider-archive-local.ps1 -Action verify
./scripts/provider-archive-local.ps1 -Action status
```

Build Core first if `backend/core/dist` is absent or stale. Setup reads the
existing local PostgreSQL settings from `deploy/compose/.env`, creates
`growthos_provider_archive` and a restricted runtime login, and generates random
archive tokens. It never migrates project business tables. Repeating setup
reuses verified configuration; it refuses to adopt an existing database or role
without that configuration. After a partially failed setup, inspect the error
and existing database/role instead of deleting or overwriting them.

Local secrets, spools and verification evidence live in the Git-ignored
`storage/provider-archive` directory, restricted to the current Windows account.
Use `-DataDirectory` to choose a different persistent location. Environment
overrides for setup are `PROVIDER_ARCHIVE_LOCAL_ADMIN_URL` (loopback only),
`PROVIDER_ARCHIVE_LOCAL_DATABASE`, `PROVIDER_ARCHIVE_PORT`, and
`PROVIDER_ARCHIVE_PROJECT_ENV`. Do not put administrator credentials in Git.

When this local configuration exists, `scripts/dev-up.ps1` enables local capture
and starts the archive processes before its native business producers. An
explicit `PROVIDER_ARCHIVE_ENABLED=false` disables this automatic integration;
an explicit `PROVIDER_ARCHIVE_CENTER_URL` uses the existing remote configuration
instead. For a custom directory set `PROVIDER_ARCHIVE_LOCAL_DIR` in the project's
environment file too. Business processes already running do not acquire new
environment variables until restarted. Manual producer launches must still load
the capture settings and shared Python module path themselves.

`verify` uses synthetic responses, never real DataForSEO requests. It preserves
clearly labeled `local-acceptance-fixture` history, checks lost-receipt retries,
and tests delivery through the independently running uploader. `status` checks
that the latest verification's records are still stored. Fixture rows are not
real website research. No earlier response data is backfilled by this command.

Stop only these native archive processes with:

```powershell
./scripts/provider-archive-local.ps1 -Action stop
```

The database remains on PostgreSQL's persistent volume. Do not delete that
volume. The archive runs independently of `dev-down.ps1`; after a machine reboot,
start it with `start` or use the project's normal `dev-up.ps1` entry. This is
local development lifecycle management, not an installed Windows service or a
cloud availability guarantee. The local address is loopback-only and cannot
serve other computers until a separate secure network deployment is configured.

## Status and scope

This is an additive archive, not a replacement for the recommendation pool or
the bundled resource library. Capture is OFF by default. No cloud address,
deployment identity, secret, or developer filesystem path is embedded in code.
Cloud provisioning and production activation require a separate acceptance.

```text
Core / Python API / Python workers
  -> durable local spool on each deployment
  -> independent uploader (HTTPS, retry, receipt verification)
  -> central archive API
  -> isolated PostgreSQL database, append-only history
```

Each actual HTTP response becomes a new event, including repeated websites and
HTTP errors. Upload retries keep the same event ID and cannot create additional
history records. The archive preserves response bytes exposed by the HTTP
client, before JSON/domain parsing, not compressed network packets.
Transport failures are explicit events without an invented response body.
Account-management `/v3/appendix/*` endpoints are excluded.

There is no retrospective recovery of responses received before activation.
Cache reads are not new provider responses. This layer does not yet parse all
historical websites into a reusable recommendation index or bypass future paid
calls based on the archive. That is a separate consumer of these immutable facts.

## Code ownership and extension points

| Concern | Location |
| --- | --- |
| Versioned event validation, digest | `backend/core/src/modules/provider-archive/contract.ts` |
| Node capture / spool | `capture-fetch.ts`, `spool.ts` in the same directory |
| Delivery / operational status | `uploader.ts`, `cli.ts` in the same directory |
| Center API / isolated schema | `center.ts`, `schema.sql` in the same directory |
| Python wire-compatible capture | `backend/provider_archive/growthos_provider_archive.py` |
| Center container deployment | `deploy/provider-archive/` |
| Optional deployment client overlay | `deploy/compose/compose.provider-archive.yaml` |

New DataForSEO transports must call the shared capture wrapper, not implement
their own archive logic. Endpoint parameters remain part of the existing provider
configuration. Storage and HTTP delivery are separate from recommendation and
billing rules. A future schema change must use explicit migrations and version
handling; do not reinterpret or rewrite existing event payloads.

## Environment required

- An always-on center host or equivalent managed container service, reachable
  from every deployment over HTTPS.
- PostgreSQL with durable storage, backup and tested restore. Use an isolated
  archive database, not the application's business database.
- A persistent local spool on every deployment, writable by all its producers
  and its uploader. An ephemeral container filesystem is insufficient.
- A service supervisor for the uploader. The optional Compose overlay supplies
  `restart: unless-stopped`; native development uses the existing managed
  `scripts/dev-up.ps1` / `dev-down.ps1` lifecycle, not production OS auto-start.
- Access to configure DNS/TLS, firewall rules, secrets, disk monitoring and
  alerting. No concrete cloud provider is required.

The included center Compose file runs its own PostgreSQL. A managed database can
instead run the same `migrate` and `serve` commands against its connection string;
the bundled PostgreSQL container is then unnecessary.

## Credentials

Generate a different strong random upload token per deployment, plus a separate
administrative read token. Never use a DataForSEO credential as an archive token.
The center credential file contains hashes only:

```json
[
  {"role":"upload","deploymentId":"team-a","tokenSha256":"REPLACE_WITH_64_HEX_SHA256"},
  {"role":"upload","deploymentId":"team-b","tokenSha256":"REPLACE_WITH_64_HEX_SHA256"},
  {"role":"admin","tokenSha256":"REPLACE_WITH_64_HEX_SHA256"}
]
```

For example, an operator can generate a token and its hash in a private terminal:

```sh
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('hex');console.log(JSON.stringify({token:t,tokenSha256:c.createHash('sha256').update(t).digest('hex')}))"
```

Store only the raw token in each deployment's restricted token file. Do not put
raw tokens, database passwords, queue contents, or credential files in Git.
The center binds upload permission to one deployment ID; upload tokens cannot
read any history, including their own. Administrative history is not a tenant
API and must not be exposed to ordinary project users.

The uploader rereads its token file on each pass. For rotation, add the new hash
alongside the old one at the center and restart the center, replace the client's
token file, verify delivery, then remove the old hash and restart the center.
Center credential changes are not hot-reloaded.

## Center startup

Use `deploy/provider-archive/.env.example` as the configuration reference.
All secret-file paths must be absolute. Set:

| Variable | Meaning |
| --- | --- |
| `ARCHIVE_POSTGRES_PASSWORD` | Password for bundled PostgreSQL |
| `PROVIDER_ARCHIVE_DATABASE_URL` | Isolated archive DB connection string; URL-encode credentials |
| `PROVIDER_ARCHIVE_CREDENTIALS_FILE` | Absolute host path to center token-hash JSON |
| `PROVIDER_ARCHIVE_PORT` | Host loopback port, default 7400 |
| `PROVIDER_ARCHIVE_HTTP_BODY_LIMIT` | Complete JSON event limit, default 48 MiB |

For bundled Compose, the internal DB host is `postgres`, database
`provider_archive`, user `archive_owner`. Launch from the repository root:

```sh
docker compose --env-file deploy/provider-archive/.env -f deploy/provider-archive/compose.yaml up -d --build
```

This is an operator instruction, not a command executed during implementation.
The migration runs before the center starts. The database has no published host
port, and the API binds only to host loopback. Put an HTTPS reverse proxy in front
of it; keep proxy body limits/timeouts consistent with the archive configuration.
Configure request limits at that trusted edge before opening public access.

For non-container operation, from `backend/core`, after `npm ci` and
`npm run build`, with the appropriate environment:

```sh
npm run archive:migrate
npm run archive:center
```

The migration command only installs the archive schema in the database supplied
to it. Verify that database before running it. The `serve` command does not
automatically migrate. `PROVIDER_ARCHIVE_HOST` defaults to `127.0.0.1`;
`PROVIDER_ARCHIVE_DATABASE_POOL_SIZE` defaults to 5.

The bundled database owner is a bootstrap convenience, not a hardened production
role. Before production, separate the migration owner from the runtime login.
Grant the runtime login only database/schema access, SELECT/INSERT on
`provider_archive_events`, and USAGE/SELECT on its identity sequence. Deny DDL
and mutation privileges. The trigger rejects UPDATE/DELETE/TRUNCATE, but a
database owner or administrator can bypass such protection. Use external,
access-controlled backups for stronger audit durability.

## Per-deployment startup

Use `deploy/provider-archive/client.env.example` as the reference.
Every separately deployed copy needs its own stable ID and persistent directory.
Processes belonging to the same deployment share that directory. Never change
the ID of a directory with pending events, and do not mount a laptop's temporary
directory as durable storage.

| Variable | Default / requirement |
| --- | --- |
| `PROVIDER_ARCHIVE_ENABLED` | `false`; explicitly enable after configuration |
| `PROVIDER_ARCHIVE_DEPLOYMENT_ID` | Required when enabled; letters, digits, dot, underscore, hyphen |
| `PROVIDER_ARCHIVE_SPOOL_DIR` | Required absolute persistent directory |
| `PROVIDER_ARCHIVE_CENTER_URL` | Required for uploader; HTTPS except local loopback tests |
| `PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE` | Required absolute path to raw upload token |
| `PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES` | 33554432; capture limit, tune to actual response sizes |
| `PROVIDER_ARCHIVE_MAX_PENDING` | 100000; approximate backlog preflight limit |
| `PROVIDER_ARCHIVE_UPLOAD_TIMEOUT_MS` | 30000 |
| `PROVIDER_ARCHIVE_UPLOAD_BATCH_SIZE` | 20 |
| `PROVIDER_ARCHIVE_UPLOAD_INTERVAL_MS` | 5000 |
| `PROVIDER_ARCHIVE_RETRY_BASE_MS` | 5000 |
| `PROVIDER_ARCHIVE_RETRY_MAX_MS` | 300000 |

Base64 adds roughly one third to response size; the center/proxy event limit must
also accommodate request bodies and metadata. Increase these limits together.
Concurrent producers can exceed the approximate backlog threshold slightly; it
is not a disk quota. Capacity planning and disk alerts remain necessary.

For native development, set these values in the existing
`deploy/compose/.env` used by `scripts/dev-up.ps1`. It propagates capture settings,
adds the shared Python module to `PYTHONPATH`, and starts the managed uploader.
It does not start the center.

For manual native processes, export the same settings to all producers and
include the absolute `backend/provider_archive` directory in `PYTHONPATH`.
The shared first-party Python module is versioned in the repo; no pip dependency
or developer-local source file is required. Start the uploader separately from
`backend/core`:

```sh
npm run archive:upload
npm run archive:status
```

For Compose application deployments, add the optional client overlay to your
existing Compose invocation:

```sh
docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.provider-archive.yaml up -d --build
```

The overlay shares the spool with Python services and the uploader. If a native
Core process participates, configure it with the same host directory and ID.
The Python Docker builds use Compose `additional_contexts` to include the shared
module. Direct `docker build` users must also pass
`--build-context provider_archive=backend/provider_archive` from the repo root,
alongside their existing API/worker build context and Dockerfile.

Files are created with mode 0600 and directories with 0700 on POSIX. The overlay
defaults the uploader to the existing Python containers' root UID for compatible
access. When hardening containers, change all participating producer/uploader
UIDs and volume ownership together, not the uploader alone. On Windows configure
equivalent restricted ACLs; POSIX modes do not establish Windows ACL isolation.

## Failure behavior and operations

- A request marker is written and fsynced before dispatch. Invalid configuration,
  unwritable storage or a full backlog prevents that dispatch.
- A captured response becomes an atomically published event. Center outages do
  not remove it or trigger a new DataForSEO request.
- Upload uses persistent exponential backoff. Only a successful receipt matching
  deployment, event ID and event digest permits local removal.
- A center commit followed by a lost receipt is safe: retry returns `existing`.
  Same website from another request is a new historical event.
- Pending events have no automatic expiration. Invalid/corrupt events are retained
  for investigation, not silently discarded.
- `.pending` without a completed event and `.writing` files indicate active work
  or an interrupted capture. Alert when they exceed the normal request duration.
  They never cause an automatic paid replay.
- Disk failure, oversized responses or termination between response receipt and
  durable capture can leave a gap. Logs contain `ARCHIVE_CAPTURE_GAP` plus event
  ID, not raw response data. This design does not claim absolute zero loss under
  disk destruction or process termination in that interval.
- File contents are fsynced. Directory fsync is available on POSIX but skipped
  on Windows because this Node interface does not support it; choose storage,
  backup and power-loss guarantees accordingly.

Monitor `GET /health` at the center, uploader process liveness, spool disk space,
and `uploader-health.json` freshness. `archive:status` reports `queued`,
`pendingCapture`, `incompleteWrites` and `oldestAgeMs`. The health file includes
attempted/delivered/failed counts. A heartbeat alone is insufficient: alert on
growing backlog, old pending captures and repeated delivery failures.
Alert routing, backups and restore schedules depend on the eventual server
environment and are not automatically installed by this code.

Treat raw archive data as restricted: request keywords and provider responses can
contain customer information even without Authorization headers. Future shared
recommendation reads should use a separately permissioned, sanitized projection,
not this administrative raw-history endpoint.

## Read history

Use the administrative Bearer token:

- `GET /v1/events?after=0&limit=20`: metadata only, sequence cursor pagination.
- Add `deploymentId` to filter one deployment.
- `GET /v1/events/:deploymentId/:eventId`: one complete event, including the
  base64 response and request body. Decode base64 to inspect original bytes.

Responses are immutable facts. Do not update a previous event when website
metrics change. The first version stores raw event JSON in PostgreSQL, without
automatic retention deletion or object-store tiering. Plan storage against real
volume and retention needs before cloud activation.

## Acceptance before cloud activation

1. Verify code/image distribution, isolated schema and all service permissions.
2. Configure two deployments with different IDs/tokens and persistent spools.
3. Use fixtures first; verify both appear at the center, outage backlog drains,
   lost receipts do not duplicate history, and unauthorized reads fail.
4. Restart uploader/center processes and verify persistent volume recovery.
5. Configure and test monitoring, backups/restores, TLS and key rotation.
6. Only then authorize a bounded real-provider check and enable normal capture.

Local implementation evidence and remaining limitations are recorded in
`docs/execution/provider-archive-20260911.md`.
