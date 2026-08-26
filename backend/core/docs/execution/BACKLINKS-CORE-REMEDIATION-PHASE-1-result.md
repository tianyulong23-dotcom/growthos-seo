# BACKLINKS-CORE-REMEDIATION-PHASE-1 Result

Status: `PASS`

Date: `2026-08-15`

Task: `BACKLINKS-CORE-REMEDIATION-PHASE-1`

Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo-main`

## Authority And Stop Boundary

Implement only Phase 1, Provider Configuration And Diagnostics, from
`docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`.

Stop after Phase 1 verification. Do not start Phase 2, execute migrations,
make a DataForSEO or Browser request, invoke paid AI, authorize/send/sync
Gmail, merge, commit, push, pull, rebase, checkout, clean, or revert unrelated
worktree changes.

## Baseline

| Item | Value |
|---|---|
| Branch | `main` |
| Baseline commit | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| Phase 0 | `PASS` |
| DataForSEO/Browser/provider call ceiling | `0` |
| Paid AI/OAuth/Gmail/send ceiling | `0` |

## Pre-Registered Owned Files

Only the following files are owned by Phase 1. A listed file may remain
unchanged when the audit proves that its existing contract already satisfies
Phase 1.

### Runtime Configuration And Diagnostics

- `backend/core/src/modules/backlinks/runtime/runtime-health.ts`
- `backend/core/src/modules/backlinks/api/health.route.ts`
- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
- `backend/api/app/core/backlinks_runtime_status.py`
- `backend/api/app/api/routes/health.py`
- `deploy/compose/.env.example`
- `scripts/dev-up.ps1`

### Focused Tests

- `backend/core/test/unit/runtime-health.test.ts`
- `backend/core/test/backlinks/api/health-route.test.ts`
- `backend/core/test/unit/local-product-quiesced-worker.test.ts`
- `backend/core/test/unit/production-runtime.test.ts`
- `backend/api/tests/test_health.py`

### Execution Control And Result

- `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`
- `docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`
- `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-1-result.md`

## Audited Existing Contracts To Preserve

The following files are verification inputs, not Phase 1 edit targets unless a
focused failing test proves that a change is required:

- `backend/core/src/modules/backlinks/runtime/live-capabilities.ts`
- `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.ts`
- `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts`
- `backend/core/src/modules/backlinks/application/policies/dataforseo-call.policy.ts`
- `backend/core/src/modules/backlinks/application/commands/project-context-projection.command.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-discovery-request.service.ts`

The implementation must preserve endpoint allowlisting, Secret References,
internal quota and budget authorization, usage reservations, request leases,
request-fingerprint dedupe, `unknown_charge` reconciliation, and versioned
project/provider Kill Switch history. Initial enabled-project Kill Switch
state remains `blocked=false`; health reads never mutate it.

## Implementation Delivered

- Added a fail-closed provider health contract with exact reason and recovery
  values for disabled, not checked, insufficient balance, invalid credentials,
  rate limiting, timeout, outage, unknown charge, and explicit blocking.
- Exposed the same nullable reason and recovery contract through Core and
  Platform health endpoints.
- Kept DataForSEO and Browser configured in the LOCAL_PRODUCT example while
  reporting both as externally `not_checked`.
- Gated provider adapter construction and execution on truthful external
  availability instead of treating an internal call or spend limit as provider
  availability. Existing endpoint allowlisting, budgets, reservations, leases,
  fingerprint dedupe, and unknown-charge controls remain in force.
- Kept AI, Gmail OAuth, Gmail send/sync, and background business dispatch
  disabled. The Worker remains running but quiesced.
- Corrected restart ownership validation in `scripts/dev-up.ps1`: persisted
  timestamps retain sub-second precision, and every managed process is checked
  again after health succeeds so a stale listener cannot satisfy startup.

## Static And Automated Verification

| Check | Result |
|---|---|
| Core focused provider-health, health-route, and restart tests | `PASS`, 3 files / 19 tests |
| Core focused external-availability runtime gate | `PASS`, 1 test; 8 unrelated tests skipped by the focused selector |
| Core TypeScript typecheck | `PASS` |
| Core production build | `PASS` |
| Focused Core ESLint on owned TypeScript files | `PASS` |
| Backlinks OpenAPI baseline | `PASS`, 72 paths |
| Platform health tests | `PASS`, 8 tests |
| Focused Platform Ruff | `PASS` |
| PowerShell parser validation | `PASS` |
| DataForSEO endpoint allowlist comparison | `PASS`, exact match across 8 endpoints |

One parallel Vitest attempt hit Windows `VirtualAlloc failed` / `spawn UNKNOWN`
resource errors before completing assertions. After stopping the isolated app,
the same focused suites passed serially with `--maxWorkers=1`.

## Isolated Restart Evidence

The isolated profile was `seo-v4-phase1-verify`; it used separate local ports
and a temporary environment file that has been removed.

| Item | Before restart | After restart |
|---|---|---|
| Build ID | `local-product-27c44b6accf6c0261445ad62` | same |
| Core API recorded PID | `45644` | `56560` |
| Worker recorded PID | `38120` | `38944` |
| Platform API recorded PID | `56400` | `44376` |
| Frontend recorded PID | `29828` | `17440` |
| Core API listener PID | `45644` | `56560` |
| Worker listener PID | `38120` | `38944` |
| Platform API listener PID | `50040` | `30100` |
| Frontend listener PID | `51512` | `19776` |

All pre-restart PIDs were absent after restart. The post-restart health snapshot
reported:

- Core running with the same build identity;
- Worker running, quiesced, and connected to PostgreSQL and Temporal, with
  `worker_quiesced` / `start_business_consumers`;
- DataForSEO configured `true`, availability `not_checked`, with
  `provider_not_checked` / `run_provider_diagnostic`;
- Browser configured `true`, availability `not_checked`, with
  `provider_not_checked` / `run_provider_diagnostic`;
- AI and Gmail configured `false`, availability `disabled`, with
  `provider_disabled` / `enable_provider`.

The build source fingerprint was
`27c44b6accf6c0261445ad623bdced75f067da94e1ab74dfd7aae678be000911`;
the artifact fingerprint was
`8abaab7ad8cdf4ce3a6ddd47bb21801311ec157789c56bd6a0f76c12667aa796`.

Before and after the valid restart, all of these tables contained zero rows:

- `backlinks.backlink_provider_requests`;
- `backlinks.backlink_provider_usage_ledger`;
- `backlinks.backlink_oauth_attempts`;
- `backlinks.backlink_send_attempts`.

The unique verification Secret Store root was never created. No secret was
resolved, and no DataForSEO, Browser, paid AI, OAuth, Gmail, or other external
provider request was made. The isolated process trees and Docker services were
stopped after identity checks; Docker data was retained.

## Validation Defects Found And Fixed

- The first startup correctly rejected a workspace-local Secret Store path with
  `BACKLINKS_SECRET_STORE_ROOT_INVALID`. Verification then used a unique path
  under the allowed LOCALAPPDATA root without creating or reading a secret.
- The first restart attempt exposed timestamp precision loss when persisted
  JSON timestamps were converted back through a string. This could leave old
  managed processes alive and let stale listeners satisfy health. Phase 1
  preserves the parsed `DateTime` precision and asserts all four current
  managed processes after health; the repeated restart proof then passed.

## Scoped Residual Debt

The complete `production-runtime.test.ts` file has three failures from
pre-existing dirty-worktree expectation drift outside the Phase 1 behavior:

- stable recommendation refill source string whitespace;
- project recommendation closure source string;
- an older fail-closed test supplies an invalid empty tenant scope and reaches
  a `TypeError` before its expected `INPUT_REQUIRED` assertion.

The new Phase 1 external-availability gate test passes. These unrelated
failures were not changed or hidden.

`scripts/dev-down.ps1` retains a pre-existing timestamp string conversion with
the same precision risk. It was outside the pre-registered Phase 1 ownership
and was not edited; the isolated Phase 1 processes were instead identity
checked and stopped explicitly before compose shutdown.

## Evidence Boundary

`IMPLEMENTED` and local test/runtime evidence do not prove real provider
credentials, balance, Browser health, Gmail readiness, deployment, or product
UAT. Those evidence classes remain unexecuted unless a later exact task
authorizes them.

## Stop Point

`BACKLINKS-CORE-REMEDIATION-PHASE-1 = PASS`.

Actual external provider calls: `0`.

No migration was executed or added by Phase 1. No commit, push, pull, merge,
rebase, checkout, clean, or unrelated-worktree cleanup occurred.

Phase 2 and every later phase remain `NOT_AUTHORIZED`. Execution stops here.
