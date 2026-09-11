# Provider archive implementation

## Scope and ownership

- Task: additive central DataForSEO response archive, durable deployment upload,
  immutable response history. User instruction dated 2026-09-11.
- Git baseline: `main`, `7df8d48d088328bd79fb0a1afef364b17cc8b6af`,
  origin `john3947/seo`. Existing dirty files belong to earlier work and are preserved.
- Owned new areas: `backend/core/src/modules/provider-archive`,
  `backend/provider_archive`, focused archive tests, isolated deployment bundle.
- Narrow integration edits: DataForSEO transports in Core, API and keyword Worker;
  package/build/startup configuration required to distribute the capture clients.
- Provider ceiling: zero real DataForSEO, Gmail, AI calls. No production migration,
  restart, commit or push. Test fixtures and an isolated disposable database only.
- Stop: implementation and local multi-deployment/failure tests. Cloud deployment,
  real-provider acceptance and recommendation inventory reuse are not this task.

## Design

Keep the existing recommendation/cost/admission flows. Capture HTTP response bodies
before SDK/domain normalization. Each HTTP response has a unique event ID; upload
retries reuse that ID. Local durable spool and central immutable records are distinct
from mutable caches. Raw response access requires an administrative read credential;
deployment credentials can only upload their own records. Account-management
endpoints are excluded from website-data collection.

The local spool is a cross-language filesystem protocol, not a browser timer or a
manual recovery script. It is configurable persistent storage, with an independently
supervised upload process. A pending request marker precedes dispatch; an unresolved
marker flags a capture gap and must never automatically replay a paid provider call.
No raw credentials or request headers are archived.

## Checkpoints

- [x] Versioned contract, center schema/API, authentication and deployment entry.
- [x] Node/Python capture integrations and durable upload/recovery.
- [x] Two-deployment history, idempotency, outages, security and adjacent regressions.
- [x] Operator documentation and exact evidence/remaining cloud requirements.

## Verification, 2026-09-11

IMPLEMENTED and TESTED for this additive local scope, not CLOUD_DEPLOYED.

| Check | Result |
| --- | --- |
| Core `npm run typecheck` | PASS |
| Core `npm run build` | PASS; bundled library check retained 49,742 rows / 49,737 domains |
| Scoped ESLint on archive, four transport integrations and archive tests | PASS |
| Node archive and four adjacent official runtime/contract suites | PASS, 5 files / 31 tests |
| PostgreSQL archive integration | PASS, 3 tests |
| Python API archive and content SERP suites | PASS, 37 tests |
| Python Worker archive, keyword provider and related-keyword contract suites | PASS, 51 tests |
| PowerShell parser on `scripts/dev-up.ps1` | PASS |
| Center Compose configuration with fixture values | PASS |
| Application Compose + client overlay model | PASS with `--no-env-resolution`; see limitation below |
| Scoped `git diff --check` | PASS, existing line-ending warnings only |
| Container image build | BLOCKED by Docker Hub authentication endpoint TCP timeout before image download/compilation |

Total focused tests: 122 passing. Provider requests used local fixture transports;
no real DataForSEO, Gmail or AI requests were sent.

The PostgreSQL tests used the existing harness's external administrator option
to create and drop a randomly named disposable `backlinks_test_*` database on the
local PostgreSQL instance. Only that disposable database received archive DDL.
No project business database or cloud database was migrated. Automatic
testcontainer provisioning initially timed out on port mapping; that attempt is
not counted as a pass.

The integration tests exercised real local HTTP and PostgreSQL:

- Two independent deployment IDs/tokens, repeated website responses retained.
- Center commit followed by lost acknowledgement; application recreation and
  uploader retry do not duplicate stored history.
- Python spool -> Node uploader -> center -> PostgreSQL wire compatibility.
- Administrative metadata pagination and individual raw-event reads.
- Existing-event content conflicts rejected; UPDATE/DELETE/TRUNCATE rejected.
- Compiled CLI migration entry runs and preserves previously stored records.

Additional tests cover capture before JSON parsing, HTTP and transport failures,
disabled configuration, preflight backlog rejection, non-provider/account
exclusions, hash checks, authorization boundaries, corrupt-event retention,
receipt mismatch and oversized-response gap visibility without paid replay.
An enabled official SDK runtime fixture confirms capture is connected to the
production adapter, not only tested as a standalone wrapper.

## Commands for reproduction

Run in `backend/core`:

```sh
npm run typecheck
npm run build
npx vitest run test/unit/provider-archive.test.ts test/unit/commercial-official-runtime.test.ts test/unit/commercial-qualification-official-runtime.test.ts test/contract/dataforseo-official-adapter.test.ts test/contract/dataforseo-profile-official-adapter.test.ts
npx vitest run test/backlinks/integration/provider-archive.test.ts --maxWorkers=1
```

For all three integration tests, set `ARCHIVE_TEST_PYTHON` to a real Python
executable and `ARCHIVE_TEST_COMPILED_CLI=true` after building Core.
The harness can use `BACKLINKS_TEST_POSTGRES_ADMIN_URL` to create its disposable
database. Never put the administrator URL or password into a committed file.

Run in `backend/api` with that project's Python environment:

```sh
python -m pytest tests/test_provider_archive.py tests/test_content_serp_analysis.py -q
```

Run in `backend/workers` with its test dependencies available:

```sh
python -m pytest tests/test_provider_archive.py tests/test_keyword_providers.py tests/test_content_plan_related_keywords_contract.py -q
```

On this machine the API virtual environment was used for both Python test runs;
plain `python` is a WindowsApps placeholder. Pytest configuration includes the
shared first-party archive module.

## Delivery and remaining requirements

See `docs/provider-archive-setup.md` for operator configuration, startup,
permissions, protocol boundaries, failure handling and cloud acceptance.
Examples are under `deploy/provider-archive`; actual secrets remain unconfigured.
The feature remains disabled by default. No running business service was
restarted, and no Git commit or push was performed.

The application Compose model check deliberately skipped service `env_file`
resolution because the local native setup has no `backend/api/.env`. This proves
overlay structure/interpolation, not complete container startup readiness.
The center image build could not reach `auth.docker.io`; neither this image nor
the Python named-context image builds have been accepted in Docker runtime.
Do not report Docker or cloud deployment as passing.

Before activation, the team must provide/verify the center host or managed
service, isolated database, network/TLS access, persistent spool volumes,
restricted runtime roles, secrets, monitoring, backups and restore procedure.
Then run two-deployment restart/outage acceptance in that actual environment,
followed by a separately authorized bounded real-provider check.

This first layer archives restricted raw response history. It does not yet add
a sanitized website index or a recommendation cache-hit/reuse policy.
Oversized responses, disk loss or interruption before durable capture can leave
explicit gaps; this is not an absolute zero-loss or physical WORM guarantee.
