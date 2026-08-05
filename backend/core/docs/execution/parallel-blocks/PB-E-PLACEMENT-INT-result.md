# PB-E-PLACEMENT-INT Result

Status: INTEGRATED
Workspace: C:\Users\DELL\Documents\缝合\john3947-seo
Handoff updated at: 2026-07-29
Task: BL-AI-144..158 shared integration

## Integrated Scope

- Registered the frozen Links and Placement public Gateway projection in
  FastAPI. The Backlinks OpenAPI baseline has 29 paths and the public
  aggregate has 51 paths and 55 operations.
- Registered Placement initial-validation and monitoring workflow definitions
  and Activity bindings on the existing `growthos.backlinks.v1` Temporal
  runtime.
- Registered `backlinks.placement-monitoring.requested.v1` and
  `backlinks.placement-monitoring.lifecycle.v1` in the Event Registry and
  connected owner-controlled outbox relay handlers.
- Bound the optional Browser fallback to the injected shared
  `crawler.evidence.v1` boundary. It is disabled by default and has no
  Browser Worker, Queue, Launcher, or independent network stack.
- Kept the integrated forward-only deployment sequence:
  `backlinks-0027 -> backlinks-0028 -> backlinks-0029`. No historical
  `0018/0019` migration was inserted.

## Migration Evidence

| Migration | SHA-256 | Result |
|---|---|---|
| `0028_backlink_placements.sql` | `c688b1c88ad5f99978613de3b92d9fa344d625ccb120f992dbe51d658edad996` | Deployment manifest match |
| `0029_backlink_monitoring.sql` | `c2fa41acbc27922faaa84c1644af38f9df94b441e59da5942e177af84ca04e51` | Deployment manifest match |

## Verification

| Command | Exit code | Result |
|---|---:|---|
| `npm run verify:backlinks` | `0` | Typecheck, lint, manifest, dependency, license, Backlinks OpenAPI, 22 migrations through `0029`, Unit 58 files/350 tests, API 25 files/73 tests, Contract 19 files/129 tests, Integration 43 files/146 passed with 13 environment-gated skips, Security 6 files/95 tests, and Resilience 1 file/3 tests passed |
| `python scripts\check_shared_contracts.py --write` | `0` | Aggregate frozen at 51 public paths, 55 operations, 1 cross-module command, 1 cross-module event, and 4 module Task Queues |
| `python -m pytest -q` from `backend/api` | `0` | 33 passed, 1 skipped |
| `backend\database\tests\verify-postgresql18.ps1` | `0` | PostgreSQL 18.4 clean install, existing upgrade/DataForSEO write compatibility, backup, restore, and RLS gates passed |

## Shared Boundaries Retained

- Fastify Core remains the private Backlinks business authority; the FastAPI
  Gateway only projects the frozen public DTOs.
- The existing FastAPI/OpenAPI aggregation, Temporal runtime, Event Registry,
  PostgreSQL 18 deployment manifest, and shared Crawler registration remain
  their existing single-owner surfaces.
- DataForSEO remains effective and unchanged.
- No real Browser, Provider, credential, production database, or production
  resource operation occurred. No commit or push occurred.

## PB-E Monitoring Decision Correction

Status: INTEGRATED
Completed at: 2026-07-29

- Every successfully completed Placement Monitoring Observation now records
  exactly one internal `placement.monitoring.status_decided` fact in the
  existing `backlink_lifecycle_events` store.
- The fact uses `aggregate_type=placement_monitor_run`,
  `aggregate_id=monitorRunId`, and `sequence=1`, so it does not consume the
  Placement lifecycle aggregate sequence.
- The immutable fact snapshot contains `monitorRunId`, `placementId`,
  `observationId`, previous and next health status, policy identity and
  contract versions, both confirmation thresholds, matching and required
  evidence counts, confirmation type, reason code, occurrence time, and fact
  contract version.
- The policy thresholds are copied from the prepared Monitor Run execution
  context. Replay never reads the current mutable policy row.
- `inaccessible` preserves the existing health status. A single `absent`
  result records `suspected_lost` and cannot emit `placement.lost`.
- Existing `placement.confirmed`, `placement.changed`, `placement.lost`,
  `placement.recovered`, and `placement.restored` lifecycle behavior remains
  unchanged. Candidate KPI semantics remain unchanged.
- Observation insertion, Monitor Run completion, Placement status update,
  decision fact insertion, lifecycle event insertion, lifecycle outbox
  insertion, and policy scheduling remain one PostgreSQL statement and one
  transaction boundary.
- Monitor Run terminal-state guards plus the lifecycle aggregate uniqueness
  constraints make completion retries return the existing result without a
  second Observation or decision fact.
- No migration was created. Migration numbering remains frozen through
  `0029`; reserved `0030/0031` were not used.
- Shared Event Registry, public API/OpenAPI DTOs, Canonical State, Browser
  fallback, and DataForSEO behavior were not changed.

### Correction Verification

| Command | Exit code | Result |
|---|---:|---|
| `npm exec vitest run test/unit/placement-monitor-workflow.test.ts` | `0` | 1 file, 10 tests passed |
| `npm exec vitest run test/backlinks/integration/monitoring-migration.test.ts` | `0` | 1 file, 12 PostgreSQL tests passed, including suspected-loss replay, historical threshold snapshot, duplicate completion, rollback, and Workspace isolation |
| `npm run verify:backlinks` | `0` | Typecheck, lint, manifest, dependency, license, OpenAPI, and migrations passed; Unit 62 files/370 tests, API 26/80, Contract 20/144, Integration 44 files/157 passed with 13 environment-gated skips, Security 7/97, and Resilience 1/3 passed |

## Handoff

`PB-E 144..158 = INTEGRATED`.

`PB-E Monitoring Decision Correction = INTEGRATED`.

- The BL-AI-160 Phase 08 controller reaccepted the correction after both
  prerequisite patch sets landed.
- Every completed Monitoring Observation has exactly one immutable decision
  fact, and historical `suspected_lost` replay uses the snapshotted policy
  thresholds instead of the current mutable policy.
- No additional BL-AI task was started.
