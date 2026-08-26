# BACKLINKS-CORE-REMEDIATION-PHASE-M1C Result

Status: `PASS`

Date: `2026-08-15`

Task: `BACKLINKS-CORE-REMEDIATION-PHASE-M1C`

Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo-main`

## Authorized Scope And Stop Boundary

Create one provider-disabled local runtime that starts the Platform API,
frontend, Backlinks Core API, and a Backlinks Core Worker process. Expose
truthful, separate API and Worker health, including normal versus quiesced
Worker state and provider configuration versus external availability.

Stop after M1C verification. Do not start Phase 0, call DataForSEO or another
provider, invoke paid AI, authorize/send/sync Gmail, merge, commit, or push.

## Baseline

| Item | Value |
|---|---|
| Branch | `main` |
| Baseline commit | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| M1A | `PASS` |
| M1B | `PASS` |
| Provider/Gmail paid-call ceiling | `0` |

## Pre-Registered Owned Files

Only the following files are owned by M1C. A listed file may remain unchanged
if implementation proves it unnecessary.

### Platform Runtime Status

- `backend/api/app/core/backlinks_runtime_status.py`
- `backend/api/app/core/config.py`
- `backend/api/app/main.py`
- `backend/api/app/api/routes/health.py`
- `backend/api/tests/test_health.py`

### Backlinks Core Runtime

- `backend/core/scripts/local-product-build-identity.ts`
- `backend/core/scripts/local-product-quiesced-worker.mjs`
- `backend/core/src/index.ts`
- `backend/core/src/modules/backlinks/api/health.route.ts`
- `backend/core/src/modules/backlinks/api/private-server.ts`
- `backend/core/src/modules/backlinks/runtime/runtime-health.ts`
- `backend/core/test/backlinks/api/health-route.test.ts`
- `backend/core/test/backlinks/api/private-server.test.ts`
- `backend/core/test/unit/local-product-build-identity.test.ts`
- `backend/core/test/unit/local-product-quiesced-worker.test.ts`
- `backend/core/test/unit/runtime-health.test.ts`

### Local Runtime Ownership

- `scripts/dev-up.ps1`
- `scripts/dev-down.ps1`
- `deploy/compose/.env.example`

### Frontend Contract

- `frontend/src/runtime-status.ts`
- `frontend/src/runtime-status-source.test.mjs`

### Result

- `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-M1C-result.md`

## Planned Verification

- Core build identity is generated from the current source and compiled output.
- Provider-disabled Core API and quiesced Worker start against PostgreSQL 18
  and Temporal without starting business consumers.
- Platform runtime status reports Core API and Worker process health
  independently and preserves provider availability distinctions.
- Frontend polling reads the expanded backward-compatible runtime contract.
- Refresh, polling, startup, shutdown, and restart create zero provider, paid
  AI, OAuth, Gmail, or send actions.
- Restart preserves the configured quiesced mode and disabled provider flags.

## Implemented

- Added a source-and-artifact-derived local-product build identity and startup
  verification.
- Added separate Core API and Worker health surfaces.
- Added a quiesced Worker process that verifies PostgreSQL and Temporal
  readiness without starting business consumers.
- Added provider configuration and external-availability reporting for
  DataForSEO, browser, AI, and Gmail.
- Added a Platform runtime-status owner that reports Core API and Worker health
  independently.
- Disabled Platform background dispatch for this local-product profile.
- Added frontend contract support for the expanded runtime status.
- Replaced the local start/stop path with one profile-scoped runtime that owns
  Platform API, frontend, Core API, Core Worker, and Docker infrastructure.
- Process records include PID, process name, and exact start time so shutdown
  can validate ownership before terminating a process tree.

## Code And Contract Verification

| Area | Command | Result |
|---|---|---|
| Core types | `npm run typecheck` | `PASS` |
| Core focused tests | focused Vitest runs for build identity, runtime health, quiesced Worker, API health, and private server | `PASS`, 17 tests |
| Core build | `npm run build` | `PASS` |
| Build identity | `npm run local-product:build-identity:check` | `PASS` |
| Core OpenAPI | `npm run openapi:backlinks:check` | `PASS`, 72 paths |
| Platform lint | focused `ruff check` | `PASS` |
| Platform health tests | `pytest tests/test_health.py -q` | `PASS`, 7 tests |
| Frontend source contract | `node --test src/runtime-status-source.test.mjs` | `PASS` |
| Frontend types | `npm run typecheck` | `PASS` |
| PowerShell startup/shutdown | two executed `dev-up.ps1` runs and two executed `dev-down.ps1` runs | `PASS` |

## Isolated Runtime Evidence

Runtime profile: `seo-v4-m1c-verify`

| Service | Local address |
|---|---|
| PostgreSQL 18 | `127.0.0.1:60432` |
| Redis | `127.0.0.1:60379` |
| MinIO | `127.0.0.1:60000` |
| Temporal | `127.0.0.1:60233` |
| Platform API | `127.0.0.1:60800` |
| Frontend | `127.0.0.1:60173` |
| Backlinks Core API | `127.0.0.1:60301` |
| Backlinks Core Worker health | `127.0.0.1:60302` |

Build identity remained:

`local-product-3bb9f3dcefe9f0a0b28d6b05`

Both the initial successful start and the same-profile restart reported:

- Platform status: `maintenance`
- business consumers running: `false`
- Core API: running, matching build identity
- Core Worker: process running, matching build identity
- Worker execution mode: `quiesced`
- Worker PostgreSQL readiness: `true`
- Worker Temporal readiness: `true`
- DataForSEO: `configured=false`, external availability `disabled`
- browser: `configured=false`, external availability `disabled`
- AI: `configured=false`, external availability `disabled`
- Gmail: `configured=false`, external availability `disabled`
- frontend root: HTTP response with the SEO application document

The first shutdown removed all four managed application process trees, stopped
all profile Docker services, and removed the PID record. All four application
addresses became unreachable. The restart then reproduced the same health,
build identity, quiesced mode, and disabled-provider state.

## Zero-Action Evidence

After initial startup and polling, and again after shutdown plus restart:

| Table | Before restart | After restart |
|---|---:|---:|
| `backlinks.backlink_provider_requests` | 0 | 0 |
| `backlinks.backlink_provider_usage_ledger` | 0 | 0 |
| `backlinks.backlink_oauth_attempts` | 0 | 0 |
| `backlinks.backlink_send_attempts` | 0 | 0 |

No DataForSEO or other provider request, paid AI request, OAuth action, Gmail
authorization/send/sync action, or send attempt was executed.

## Cleanup

- `seo-v4-m1c-verify` containers, network, and named volumes were removed.
- The temporary environment file was removed.
- The profile runtime directory, logs, PID record, and local secret files were
  removed.
- No M1C process or execution session remains running.

## Evidence Boundary

This is local code, contract, and disposable-runtime evidence only. It is not
real-provider evidence, Gmail send readiness, deployment evidence, human
approval, or UAT.

## Commit And Push Permission

None.

## Stop Point

M1C is complete. Stop here. Phase 0 remains blocked and out of scope until it
is separately authorized.
