# Backlinks Kill Switch and Disaster Recovery Runbook

Status: BL-AI-194 local test-environment drill.

## Safety Boundary

- Run only against disposable local test resources.
- Do not use production credentials, databases, Gmail, Pub/Sub, DataForSEO,
  AI, or a Browser provider.
- Keep Provider, send, Browser fallback, and Worker capabilities disabled
  before starting the recovery drill.
- Restore only into a temporary restore database. The procedure must not target production
  or overwrite an existing database.

## Test Environment

- PostgreSQL: pinned PostgreSQL 18 image from
  `backend/database/tests/verify-postgresql18.ps1`.
- Migrations: deployment-manifest Backlinks head `0032`.
- Provider: injected fake only; a closed `backlinks.dataforseo.v1` Kill Switch
  must return `KILL_SWITCH_ACTIVE` before the Provider port is invoked.
- Send: injected operation only; an active Gmail send Kill Switch must return
  `GMAIL_SEND_POLICY_BLOCKED` before the operation is invoked.
- Browser: shared Crawler Browser fallback remains disabled unless both
  capability and adapter are explicitly enabled. The disabled path must return
  `disabled` without resolving Crawler context or collecting evidence.
- Worker: `BACKLINKS_WORKER_ENABLED` is absent or `false`; startup must fail
  before the Temporal Worker factory is invoked.

## Kill Switch Drill

Run the focused offline tests:

```powershell
npx vitest run test/unit/settings-governance.test.ts test/unit/dataforseo-request.service.test.ts test/unit/gmail-send-policy-gate.test.ts test/unit/shared-crawler-browser-fetch.adapter.test.ts test/backlinks/integration/temporal-worker.test.ts
```

Accept only when all of the following are observed:

1. Layered Kill Switch evaluation fails closed by default and when its authority
   is unavailable.
2. DataForSEO Provider invocation count remains zero while its switch is closed.
3. Gmail send operation invocation count remains zero while its switch is
   closed.
4. Browser context resolution and evidence collection counts remain zero while
   Browser fallback is disabled.
5. Temporal Worker factory invocation count remains zero while the Worker
   switch is disabled.

Do not re-enable a capability as part of this drill. A future activation
requires its normal explicit authorization and deployment review.

## Backup and Restore Drill

Run:

```powershell
powershell -ExecutionPolicy Bypass -File backend/database/tests/verify-postgresql18.ps1
```

The equivalent backup and temporary restore operations executed inside the
disposable container are:

```powershell
pg_dump -U postgres -d seo_upgrade --format=custom --file=/tmp/seo4-int-004.dump
docker cp backend/database/roles/0001_growthos_schema_roles.sql <postgres-container>:/tmp/0001_growthos_schema_roles.sql
psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/0001_growthos_schema_roles.sql
createdb -U postgres seo_restore
pg_restore -U postgres -d seo_restore --exit-on-error /tmp/seo4-int-004.dump
```

The script:

1. Starts a labeled disposable PostgreSQL 18 container and network.
2. Applies the clean-install and supported historical-upgrade chains through
   Backlinks migration head `0032`.
3. Confirms the existing DataForSEO rows remain readable and writable without
   making a Provider call.
4. Captures every `backlinks` table row count before backup, which includes and
   broadens the prior key table counts.
5. Creates a PostgreSQL custom-format backup with `pg_dump`.
6. Bootstraps the repository's cluster roles against the disposable
   maintenance database before restoring schemas whose policies reference
   those roles.
7. Restores the archive with `pg_restore` into the temporary `seo_restore`
   database.
8. Re-runs database contracts and DataForSEO compatibility checks.
9. Captures every restored `backlinks` table row count and fails if any table
   differs from the source.
10. Removes the disposable container and network in `finally`.

The declared objectives are RPO: 60 minutes and RTO: 4 hours. The local drill
passes only when migration/schema contracts pass, the source contains at least
one Backlinks fact, every source/restored table count matches, and both
temporary resources are removed.

## Evidence

Record the exact focused-test count, PostgreSQL version, compared table count,
total fact count, RPO/RTO result, and post-run process/resource checks in the
BL-AI-194 Canonical State entry. Any required command with a nonzero exit code
must be fixed and rerun before BL-AI-194 can be marked DONE.
