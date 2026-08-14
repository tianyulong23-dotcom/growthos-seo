# LOCAL-PRODUCT-035 Result

## Task Start Card

- Task ID: `LOCAL-PRODUCT-035`
- Task name: Historical `v2 -> v3` idempotent reassessment and project state restoration
- Authority:
  - `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
  - `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-result.md`
  - `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-034-runtime-handoff-result.md`
  - Current Canonical PostgreSQL data and Temporal state
- Result path: `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-035-result.md`
- Scope:
  - Execute manual checkpoints `CP1 -> CP4`.
  - Preserve immutable historical v2 scores, evidence, and audit facts.
  - Append generic v3 reassessment facts using only each Website Project's own context and evidence.
  - Reuse valid public-email evidence; leave expired or incomplete evidence on the existing enrichment path.
  - Coordinate historical `BUDGET`, `PROVIDER_UNAVAILABLE`, and `TIERS_EXHAUSTED` recovery state without deleting or manually rewriting the existing waiting Job, running Batch, or pending outbox.
  - Take a PostgreSQL backup before Canonical apply, run dry-run, review its summary, apply once, and verify a second dry-run is empty.
- Initially allowed files:
  - `backend/core/src/modules/backlinks/**` only where the generic reassessment command/service requires it.
  - `backend/core/scripts/**` only for the scoped generic dry-run/apply entrypoint.
  - `backend/core/test/**` and `backend/database/tests/**` only for directed `LOCAL-PRODUCT-035` verification.
  - One next-number forward migration and required manifest/status references only if the current schema cannot preserve the required independent facts.
  - This result document.
- Provider ceiling:
  - DataForSEO: `0 calls / 0 micros`.
  - AI: `0 calls`.
  - Gmail Send: `0 calls`.
  - Gmail Sync: `0 calls`.
  - Browser Provider: `0 calls`.
  - Provider ledger, request, lease, task, and actual-cost counts must not increase.
- Runtime boundary:
  - Worker remains `quiesced`; no Temporal task polling or business consumers.
  - Do not consume the pending outbox or start recommendation inventory scanning.
  - Do not start FastAPI, frontend, or Browser Worker.
  - Do not restore the normal Worker.
- Verification plan:
  - Read-only preflight of Job, Batch, Outbox, Temporal Workflow, provider request/task/cost/lease, budget, and idempotency-key relations.
  - PostgreSQL backup plus restore-list verification.
  - Directed unit/integration tests for v2 history, project isolation, contact evidence validity/expiry, terminal-state recovery, and dry-run/apply idempotency.
  - PostgreSQL 18 clean install, upgrade, migration manifest, and RLS verification.
  - Before/after Canonical and provider-ledger snapshots.
- Git policy: preserve the dirty worktree; no unrelated cleanup, no commit, no push.
- Stop point: write the exact result and stop after `LOCAL-PRODUCT-035`; do not start `LOCAL-PRODUCT-036`.

## Final Result

- Status: `TESTED`
- `handoffReadyFor036=true`
- Applied Build ID: `local-product-2337ef16419c97c3e86628d1`
- Runtime remained `maintenance_ready`.
- Worker remained `quiesced` with
  `businessConsumersRunning=false`.
- No normal Worker, Temporal business polling, inventory scan, FastAPI,
  frontend, Browser Worker, or `LOCAL-PRODUCT-036` was started.
- This result does not claim `REAL_PROVIDER_VERIFIED`.

## Modified Files

Production and migration:

- `backend/core/src/modules/backlinks/domain/recommendations/historical-commercial-reassessment.ts`
- `backend/core/src/modules/backlinks/application/services/historical-commercial-reassessment.service.ts`
- `backend/core/src/modules/backlinks/application/services/recommendation-publication.service.ts`
- `backend/core/src/modules/backlinks/application/commands/contact-enrichment.command.ts`
- `backend/core/scripts/reassess-historical-commercial-candidates.ts`
- `backend/core/src/modules/backlinks/db/migrations/0058_backlink_refill_reassessment_cursors.sql`
- `backend/core/package.json`
- `backend/database/deployment-manifest.v1.json`
- `ops/local-product/Start-GrowthOS-LocalProduct.ps1`
- `ops/local-product/Status-GrowthOS-LocalProduct.ps1`

Directed verification:

- `backend/core/test/unit/historical-commercial-reassessment.test.ts`
- `backend/core/test/unit/historical-commercial-reassessment.service.test.ts`
- `backend/core/test/unit/contact-enrichment-command.test.ts`
- `backend/core/test/unit/recommendation-publication.test.ts`
- `backend/core/test/backlinks/integration/historical-commercial-reassessment-migration.test.ts`
- `backend/core/test/unit/local-product-process-scripts.test.ts`
- `backend/api/tests/test_database_migration_system.py`
- `backend/database/tests/verify-postgresql18.ps1`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-035-result.md`

No project ID, domain, ElephTV, AWOL, or Aiper branch was added to production
reassessment behavior. Runtime guard IDs were supplied only as command input
for the authorized read-only safety comparison.

## CP1: Versioned v2 To v3 Reassessment

- Historical `recommendation-commercial-fit.v2` candidate rows, component
  evidence, scores, timestamps, and audit facts were not overwritten.
- The reassessment maps each candidate's own immutable v2 inputs and its own
  Website Project context into a new
  `recommendation-commercial-fit.v3` candidate fact.
- Promoted candidates receive an append-only v3 recommendation score where a
  numeric score is available.
- The uniqueness contract is project, context, domain, and model version, so
  reruns cannot replace either the v2 row or the first v3 row.
- Before apply, `235` v2 candidates lacked a matching v3 row. After apply,
  that count is `0`.

## CP2: Contact Evidence Reuse

- Valid public-email evidence is reusable only when it is non-guessed,
  non-invalidated, fresh, sufficiently confident, has an allowed purpose, and
  is backed by an allowed public extraction method.
- Valid existing evidence was synchronized through the publication service
  without changing the historical enrichment Job outcome.
- Missing, expired, or otherwise unusable evidence was routed only through the
  existing Contact Enrichment Job and outbox identity.
- Browser use remained disabled.
- Apply reused `22` valid evidence paths directly.
- Of `47` candidates requiring the existing evidence path, `38` terminal
  retryable Jobs were re-queued and `9` stale contexts were skipped.
- No second Contact Job was created. Exactly `38` contact-enrichment outbox
  events were appended and left `pending`; the quiesced Worker did not consume
  them.

## CP3: Historical Refill State Coordination

- Migration `0058` adds independent nullable paid and resource refill cursors:
  `paid_refill_tier`, `paid_refill_round`, `resource_refill_tier`, and
  `resource_refill_round`.
- Existing exact paid history is backfilled into the paid cursor.
- Existing curated resource-library history is preserved in the resource
  cursor without falsely treating it as a paid Provider attempt.
- `BUDGET` recovery requires a new budget period, remaining budget, a paid
  cursor, and no active Job, Batch, or refill outbox.
- `PROVIDER_UNAVAILABLE` recovery requires its retry time to be due, a paid
  cursor, and no active Job, Batch, or refill outbox.
- `TIERS_EXHAUSTED` remains terminal and is not reopened.
- Apply recovered `1` historical `BUDGET` policy and `1` due
  `PROVIDER_UNAVAILABLE` policy. Both `TIERS_EXHAUSTED` policies remained
  terminal.

## CP4: Backup, Dry Run, Apply, Idempotency

PostgreSQL backup:

- Path:
  `C:\Users\DELL\AppData\Local\GrowthOS\live001\backups\LOCAL-PRODUCT-035-pre-apply-20260811-122750.dump`
- Size: `3,003,309` bytes
- SHA-256:
  `696fe3a26b6c8dbf8ea5e8893cd4f178953becdac78849a890b1731da5acfe6b`
- Restore-list verification: `1,066` TOC lines.

Schema migration:

- Migration: `0058_backlink_refill_reassessment_cursors.sql`
- SHA-256:
  `b10af8c2b69b47587b68888ea5400eaf01784d032b29d580c704c7bd7315ec90`
- Live Backlinks migration head after apply: `0058`
- `0057` was not modified.
- Migration temporarily removes forced RLS only inside its owner transaction
  for the deterministic backfill, then restores forced RLS before commit.

First dry-run summary:

- Scanned Website Projects: `3`
- Missing v3 candidates: `235`
- Direct reassessments: `170`
- Decisions: eligible `79`, ineligible `91`, insufficient data `19`,
  manual review `46`
- Promoted candidates: `139`
- Reusable contact evidence: `22`
- Existing contact evidence path required: `47`
- Estimated recovered publications: `22`
- Recoverable policies: BUDGET `1`, PROVIDER_UNAVAILABLE `1`
- Active-work policies skipped: `0`
- `TIERS_EXHAUSTED` preserved: `2`
- Estimated Canonical changes: `284`

Apply summary:

- v3 candidates inserted: `235`
- v3 recommendation scores inserted: `139`
- Publication synchronizations: `139`
- Policies recovered: `2`
- Contact Jobs created: `0`
- Existing Contact Jobs retried: `38`
- Stale contexts skipped: `9`
- Contact-enrichment outbox events appended: `38`

Second dry-run summary:

- Projects with remaining candidate work: `0`
- Candidates to insert: `0`
- Scores to insert: `0`
- Publications to synchronize: `0`
- Policies to recover: `0`
- Contact Jobs/outbox events to create or retry: `0`
- Estimated changes: `0`
- `TIERS_EXHAUSTED` policies still preserved: `2`

Two pre-apply attempts failed closed before any Canonical mutation:

- The first detected an invalid unscoped RLS safety snapshot.
- The second detected that the guarded pending Project Analysis outbox
  belonged to an inactive project omitted from the audit scope.
- The command was corrected to use one repeatable-read, read-only safety
  transaction and to include explicitly supplied guard-project IDs in safety
  auditing only. Reassessment scope remains the generic active Website Project
  list.
- Both failures occurred before Provider access or Canonical apply.

## Before And After Counts

| Fact | Before | After |
|---|---:|---:|
| Commercial candidates v2 | 236 | 236 |
| Commercial candidates v3 | 604 | 839 |
| v2 candidates missing v3 | 235 | 0 |
| Recommendation scores v2 | 139 | 139 |
| Recommendation scores v3 | 19 | 158 |
| Recommendation inventory total | 200 | 200 |
| Published inventory | 3 | 25 |
| Historical BUDGET policies | 1 | 0 |
| Historical PROVIDER_UNAVAILABLE policies | 4 | 3 |
| Historical TIERS_EXHAUSTED policies | 2 | 2 |
| Contact Enrichment Jobs | 197 | 197 |
| Contact Enrichment outbox events | 353 | 391 |
| Recommendation Refill Jobs | 67 | 67 |
| Commercial Discovery Batches | 19 | 19 |
| Recommendation Refill outbox events | 67 | 67 |
| Project Analysis outbox events | 9 | 9 |
| Pending Project Analysis outbox events | 1 | 1 |

All `235` new candidates and `139` new scores were created by
`LOCAL-PRODUCT-035`. Exactly `2` policies and `38` pre-existing Contact Jobs
were updated by the task. The `38` new Contact Enrichment outbox events remain
pending.

## Provider And Gmail Zero-Call Evidence

| Safety fact | Before | After |
|---|---:|---:|
| Legacy Provider requests | 177 | 177 |
| Active legacy requests | 0 | 0 |
| Provider batch requests | 91 | 91 |
| Active Provider batch requests | 0 | 0 |
| Active Provider task IDs | 0 | 0 |
| Active Provider actual cost | 0 | 0 |
| Provider leases | 52 | 52 |
| Active Provider leases | 0 | 0 |
| Provider ledger entries | 174 | 174 |
| Reserved ledger entries | 0 | 0 |
| Ledger actual cost micros | 3,030,768 | 3,030,768 |
| DataForSEO spent micros | 950,976 | 950,976 |
| DataForSEO remaining micros | 49,024 | 49,024 |

- DataForSEO: `0 calls / 0 micros`
- AI: `0 calls`
- Gmail Send: `0 calls`
- Gmail Sync: `0 calls`
- Browser Provider: `0 calls`
- DataForSEO remained enabled with
  `absoluteBudgetMicros=1000000` and `maxPaidCalls=250`.
- Gmail Send and Gmail Sync remained independently enabled.
- There are `2` historical Gmail send-attempt rows globally; the latest was
  created on `2026-08-03`, and none was created by `LOCAL-PRODUCT-035`.
- There is `1` historical project mail-sync cursor globally, last updated on
  `2026-08-04`; no Gmail cursor was created or updated by this task.

## Guarded Runtime Records

The following records were unchanged:

- Recommendation Refill Job
  `36e44372-c101-485a-bcca-5ec9811bcdbd`:
  `waiting_provider`, step `provider_request_authorizing`, progress `10`,
  retry count `0`, version `3`.
- Commercial Discovery Batch
  `fe1ef5f3-40ea-4711-b3fe-80bfe1158d5a`:
  `running`, Provider fingerprints `0`, paid cost `0`, no finish timestamp.
- Project Analysis outbox
  `6bdd8799-a8ee-4983-909b-564edbf0bed0`:
  `pending`, attempt count `0`, unclaimed, unpublished, aggregate version `1`.

Temporal's running-workflow audit found exactly one pre-existing Gmail polling
Workflow and `0` Recommendation Refill Workflows.

## Directed Verification

- Core typecheck: passed.
- Backlinks migration manifest check: `51` files through `0058`, passed.
- Directed unit suite: `5` files, `29` tests, passed.
- Historical reassessment PostgreSQL integration suite: `3` tests, passed.
- Integration assertions cover the 0057-to-0058 upgrade, exact and curated
  cursor backfill, immutable historical fields, final forced RLS, constraints,
  and arbitrary Website Project isolation.
- PostgreSQL verification gate passed on PostgreSQL `18.4`:
  clean install, existing-database upgrade, manifest verification, RLS,
  backup/restore, recovery fact checks, and embedded database contract tests.
- PowerShell parsing for the modified Start and Status scripts passed.
- `git diff --check` passed; existing line-ending warnings were not modified or
  normalized.

## Final Runtime Evidence

- `status=maintenance_ready`
- `apiBuildId=local-product-2337ef16419c97c3e86628d1`
- `workerBuildId=local-product-2337ef16419c97c3e86628d1`
- `build.matches=true`
- Expected, configured, and running API/Worker Build IDs are non-empty and
  identical.
- `workerExecutionMode=quiesced`
- `businessConsumersRunning=false`
- PostgreSQL `18.4`: healthy, Backlinks head `0058`, RLS ready.
- Temporal: healthy, `namespaceReady=true`.
- FastAPI, frontend, and Browser Worker remain stopped.

## Frozen Contract For LOCAL-PRODUCT-036

`LOCAL-PRODUCT-036` must not reimplement:

- immutable v2-to-v3 historical candidate and score reassessment;
- the valid public-contact evidence reuse and expiry rules;
- routing missing/expired evidence through the existing Contact Enrichment
  Job/outbox identity;
- the independent paid and resource refill cursor schema and backfill;
- the BUDGET, PROVIDER_UNAVAILABLE, and TIERS_EXHAUSTED historical recovery
  decisions;
- the guarded dry-run/apply/second-dry idempotency entrypoint.

Task 036 may consume these frozen facts for its authorized orchestration scope,
but it must not overwrite historical v2 evidence, create a parallel Worker or
Task Queue, or bypass the existing Job/outbox/provider ledger contracts.

## Exact Stop State

- `status=TESTED`
- `handoffReadyFor036=true`
- The LOCAL-PRODUCT-036 Build ID and data prerequisites are satisfied.
- Worker remains quiesced; pending business work remains unconsumed.
- `LOCAL-PRODUCT-036` was not started.
- Normal Worker, FastAPI, frontend, and Browser Worker were not started.
- No commit or push was performed.
