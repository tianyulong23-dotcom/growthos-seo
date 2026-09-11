# Backlinks Recommendation Pool V2 Fix Implementation Evidence 001

- Date: 2026-09-03
- Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001`
- Completed gates: `GATE_0`, `GATE_1`
- Current result: `GATE_1 PASS`
- Hard stop: no migration 0091 and no production runtime wiring

## 1. Evidence Boundary

This result proves only the Gate 0 baseline, ownership, policy freeze and local
test/tool maintenance. It does not prove native V2 admission, migration 0091,
real-provider acceptance, deployment or human UAT.

Actions intentionally kept at zero:

- DataForSEO calls: 0
- Gmail calls: 0
- durable business-data writes: 0
- service start/stop/restart actions: 0
- migration 0091 creation or application: 0
- commit: 0
- push: 0
- deployment: 0

## 2. Repository Baseline

| Item                    | Observed value                                   |
| ----------------------- | ------------------------------------------------ |
| Git root                | `C:\Users\DELL\Documents\缝合\john3947-seo-main` |
| Remote                  | `https://github.com/john3947/seo.git`            |
| Branch                  | `main`                                           |
| HEAD                    | `7df8d48d088328bd79fb0a1afef364b17cc8b6af`       |
| Worktree                | 256 paths: 135 tracked/staged and 121 untracked  |
| Backlinks manifest head | `0090`                                           |
| Manifest validation     | 82 files valid through `0090`                    |

The dirty worktree was preserved. No unrelated path was cleaned, reverted,
formatted or moved.

## 3. Ownership Ledger

| Scope                                                     | Gate 0 owner and rule                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Fix plan and this evidence                                | Current task                                                                               |
| V2 operational policy declaration and focused policy test | Current task; constants only, no runtime wiring                                            |
| Five stale point/latest migration tests                   | Current task for manifest-order maintenance only                                           |
| Four historical migration runners                         | Current task for later-head compatibility only                                             |
| Migrations 0080-0090                                      | Stable prerequisite baseline under current-task checkpoint custody; no Gate 0 byte changes |
| V2 pool/seed repositories                                 | Stable prerequisite baseline under current-task checkpoint custody; no Gate 0 byte changes |
| Deployment manifest                                       | Existing broad formatting baseline remains inherited/user-owned; Gate 0 made no changes    |
| All other dirty paths                                     | Outside this task and preserved                                                            |

An idle or completed historical task is not treated as a live owner. Only a
live task changing an overlapping path blocks that path and its dependent work
package.

## 4. Checkpoint

Repository-external checkpoint:

`C:\Users\DELL\Documents\缝合\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001-20260903T024128Z`

| Check                               | Result                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| Manifest files                      | 21                                                                 |
| ZIP entries                         | 21                                                                 |
| ZIP bytes                           | 181,673                                                            |
| ZIP SHA-256                         | `b5b3b7d1079bf85448f28a947a42d731680f3f3844a1b87d86e3d47e364edd90` |
| Migration 0080-0090 manifest hashes | 11/11 matched                                                      |

Supplemental pre-edit copies were also created for the migration tests,
migration runners and V2 policy test. Source and checkpoint hashes matched
before edits.

## 5. Authoritative Inputs

| Document                      | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| Product requirements V2       | `fedd1996eb22fb107a4a3e685aded785c1c3f3c73462706fbb2c7f1eb732877e` |
| Compatibility and coding plan | `b4cf09f4a128d467d376230192770a317cd8c03e1a1452ffe62169e4f869a3dc` |

The authoritative coding document's Phase 0 requires audit, ownership,
migration-number availability and contract locking. It does not require a
throwaway test-only implementation of future migration 0091.

## 6. Anti-Stall Corrections

The returned Gate 0 `BLOCKED` result exposed plan and tooling defects rather
than a missing product decision:

1. A repository-external local checkpoint was incorrectly treated like a Git
   commit/push action requiring another authorization.
2. A historical task's strictly read-only Stage 0 rule was incorrectly applied
   to this plan's Gate 0, which explicitly permits local evidence and test/tool
   maintenance.
3. Future 0091 behavior was made a Gate 0 prerequisite, creating a circular
   dependency. It is now a Gate 1 expected-red contract and a Gate 2 production
   exit condition.
4. Point-migration tests assumed their target was still the current manifest
   head or applied later migrations before the target under test.
5. Historical migration runners rejected a valid append-only manifest when its
   current head was later than their exact target.
6. The plan described a 30-second contact retry as existing behavior. Current
   V1 recovery writes `retry_after=now()` and remains unchanged. The 30-second
   value is now explicitly a new, declarative V2 default whose runtime wiring
   belongs to Gate 7.

## 7. Frozen V2 Policy

`recommendation-pool-operations.v1` now declares, without runtime wiring:

| Policy                               | Frozen value                            |
| ------------------------------------ | --------------------------------------- |
| Paid requests per initial generation | 25 maximum                              |
| Provider rows per request            | 100 maximum                             |
| Raw observations                     | 2,500 maximum                           |
| Round budget                         | USD 1 maximum                           |
| Initial generation budget            | USD 2 maximum                           |
| Safe supply target                   | 100 admitted unique domains             |
| Hard candidate limit                 | 1,000 admitted/effective unique domains |
| Contact pages/depth/attempts         | 8 / 2 / 3                               |
| Contact poll interval                | 15 minutes                              |
| V2 retry delay                       | 30 seconds                              |
| Static fetch timeout                 | 12 seconds                              |
| Browser Worker timeout               | 20 seconds                              |
| Contact activity ceiling             | 8 minutes                               |
| Batch preparation deadline           | 24 hours                                |

The request count is still constrained by the durable provider authorization
and remaining cost budget. The raw-observation limit does not consume or alter
the 1,000 admitted-domain limit.

## 8. Reproduced Current Product Failure

The existing AWOL sample evidence remains the pre-fix business fixture:

- 17 raw provider results
- 6 canonical unique domains
- 5 domains recorded as insufficient data
- 1 domain received V1 score `30.47`, below the V1 threshold `50`
- 0 native V2 admitted candidates
- terminal projection became `INPUT_REQUIRED`
- prior released pool remained visible
- observed wall time was approximately 209 seconds

This is historical diagnostic evidence. No new provider call was made during
Gate 0.

## 9. Local Verification

Final focused verification after the corrections:

| Check                                              | Result                                   |
| -------------------------------------------------- | ---------------------------------------- |
| V2 policy plus migration test group                | 8 files passed, 70 tests passed          |
| TypeScript                                         | `tsc --noEmit` passed                    |
| Backlinks migration checker                        | 82 files valid through `0090`            |
| Scoped `git diff --check`                          | passed                                   |
| Active `recommendation-pool-v2` Temporal workflows | 0                                        |
| API health                                         | `ok`                                     |
| Worker health                                      | `ok`                                     |
| API/Worker build ID                                | `local-product-fda42f1839c0a35d82c4480e` |

One initial static audit command had an invalid PowerShell regular expression.
It was a command-construction error, not a code failure, and was rerun with
fixed-string checks.

## 10. Gate Decision

Gate 0 is `PASS`.

The next permitted boundary is Gate 1: add expected-red product-contract tests
for the Blueprint identity/concurrency path, immutable V2 input pin, native
candidate authority, compatibility carrier, historical-domain race handling,
staged-generation lineage and Temporal replay. Migration 0091 and production
behavior remain Gate 2 or later work.

## 11. Gate 1 Boundary

Gate 1 converted the required V2 product contracts into executable tests before
changing production semantics. A Gate 1 `PASS` means the required tests exist
and fail only for confirmed current-product gaps. It does not mean the
Recommendation Pool V2 behavior is fixed.

Gate 1 actions intentionally kept at zero:

- production source edits: 0
- migration 0091 creation or application: 0
- deployment-manifest edits: 0
- DataForSEO calls: 0
- Gmail calls: 0
- durable business-data writes: 0
- service or Worker lifecycle actions: 0
- commit, push or deployment: 0

The repository remained on `main` at
`7df8d48d088328bd79fb0a1afef364b17cc8b6af`, and the Backlinks manifest head
remained `0090`.

## 12. Gate 1 Executable Contracts

The Gate 1 matrix now covers:

| Contract group           | Executable coverage                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native admission         | unknown metrics, score below the V1 threshold, missing contact enrichment, and the closed hard-exclusion set                                                     |
| V2 generation identity   | exact V2 admission/visibility/materialization/Worker contracts, additive V2 input pin, unchanged V1 pin, and exact project-context pin validation                |
| Candidate authority      | four forced-RLS candidate tables, immutable candidate/source/metric facts, canonical materialization lineage, and no fabricated V1 qualification                 |
| Compatibility bridge     | deterministic zero-cost carrier, `v2_materialized` candidate state, non-`PUBLISHED` inventory, and complete release-item lineage                                 |
| Blueprint and launch     | fresh project without prior Blueprint, concurrent exact Blueprint reuse, missing-seed pre-provider stop, and confirmed-seed UI/API gate                          |
| Discovery and accounting | multiple request windows per round, distinct Round 2 dimension, per-request authorization/reservation/intent/outcome/replay identity, and zero-provider Get More |
| Terminal projection      | zero-valid exhausted, 1-99 partial exhausted, provider/system failed, and immutable fresh higher-generation recovery                                             |
| Feed history             | historical release visibility across generation/input-pin rotation plus separate `RUNNING` and `FAILED` latest-generation projection                             |
| Historical-domain race   | release/Opportunity ownership exclusion while retaining new evidence, generation candidate uniqueness, and project-domain release uniqueness                     |
| Phase 9                  | complete staged V2 lineage before rotation, no active-project dependency, and rejection of partial, mismatched, cross-generation or V1 lineage                   |
| Temporal                 | captured-history replay requirement or explicit patch/new workflow isolation                                                                                     |

Gate 1 test files:

- `backend/core/test/unit/recommendation-pool-v2-admission.contract.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-dataforseo-executor.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-generation-launcher.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-workflow.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-temporal-replay.contract.test.ts`
- `backend/core/test/unit/recommendation-feed-v2-history.contract.test.ts`
- `backend/core/test/backlinks/integration/recommendation-pool-v2-candidate-authority.contract.test.ts`
- `backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-api.test.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.test.tsx`

Existing focused policy, finalizer and provider-ledger tests were retained as
green controls.

## 13. Gate 1 Verification

| Check                                    | Result                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Backend unit/contract matrix             | 8 files: 6 expected-red, 2 passed; 16 expected-red tests, 48 passed |
| Candidate-authority schema integration   | 10/10 expected-red                                                  |
| Blueprint/input-pin integration subset   | 2 expected-red, 6 skipped by test filter                            |
| Frontend generate-confirmation matrix    | 2 expected-red, 6 passed                                            |
| Existing provider-ledger baseline subset | 5 passed, 13 skipped by test filter                                 |
| Backend TypeScript                       | passed                                                              |
| Frontend TypeScript                      | passed                                                              |
| Gate 1 test formatting                   | passed                                                              |

Repository-external logs:

- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\gate1-backend-unit-final.log`
- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\gate1-schema-integration-final.log`
- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\gate1-seed-integration-final.log`
- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\gate1-frontend-final.log`
- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\gate1-provider-ledger-baseline-final.log`

## 14. Confirmed Expected-Red Reasons

The failures are product-contract gaps, not fixture, import, PostgreSQL
container, TypeScript or formatting failures:

1. The V2 admission authority module does not exist.
2. Generation launch and project-context projection still use V1 contract and
   input-pin semantics.
3. Migration 0091 and its four candidate-authority tables, lineage columns,
   compatibility branch and hard-exclusion constraints do not exist.
4. A fresh project still requires a prior commercial Blueprint, and native V2
   launch reuses the V1 input pin.
5. Phase 9 still authorizes through the active project contract instead of the
   exact staged recommendation lineage.
6. Discovery still maps a round to one request/window path.
7. Zero-valid, partial-exhausted and provider/system failure statuses are
   projected incorrectly.
8. Historical feed reads remain bound to the current generation/input pin and
   do not return a separate latest-generation state.
9. The generate API/UI still permits launch before confirmed seeds.
10. No captured Temporal history fixture exists for replay.
11. Completed failed/published jobs can still be selected for in-place recovery.

## 15. Gate 1 Decision

Gate 1 is `PASS`.

The required red contracts are executable and fail for documented current
product reasons. Gate 2 is the next permitted boundary: introduce migration
0091 and the V2 candidate authority until the Gate 2 subset turns green.
Production behavior, real-provider acceptance, deployment and human UAT remain
unproven.

## 16. Gate 2 Boundary

Gate 2 was executed on September 3, 2026 from repository HEAD
`7df8d48d088328bd79fb0a1afef364b17cc8b6af`.

The pre-edit checkpoint is:

- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001-GATE2-PREEDIT-20260903T041119Z`

No commit, push, deployment, real-provider request or human UAT was authorized
or performed. The shared dirty worktree was preserved.

## 17. Gate 2 Implementation

Gate 2 introduced the V2 candidate authority without relabelling or mutating V1
history:

1. Migration `0091` adds immutable, forced-RLS candidate, source, metric and
   materialization-link authority tables.
2. Candidate facts store exact admission contract, immutable decision evidence,
   request intent, recommendation marker/reasons and admission timestamps.
3. Source outcomes and metric value states use closed enums. Unavailable,
   failed and unsupported metrics remain SQL `NULL` and do not alter admission.
4. Project-domain history checks include the project domain, release history
   and Opportunity history, with database race guards retained.
5. V2 canonical materialization uses one deterministic zero-cost carrier and
   one idempotency fingerprint. V2 carrier candidates are immutable after
   insert and cannot be rewritten into V1 score/state history.
6. Recommendation, inventory and release rows carry exact generation, context,
   visible generation, input-pin and materialization lineage. Compatibility
   inventory remains non-`PUBLISHED`.
7. Generation launch creates or reuses an additive V2 input pin and binds each
   new V2 generation to exact V2 admission, visibility, materialization and
   Worker contracts.
8. Project-context projection now uses an exact V1/V2 pool-to-pin contract
   allowlist instead of a V1-only pin check.
9. Seed confirmation resolves or creates the commercial Blueprint for a fresh
   project without requiring a prior V1 discovery run.
10. Canonical recovery selects only unfinished generation jobs. Completed
    failed or published jobs are not repaired in place; later attempts require
    a fresh higher generation.
11. The finalizer reads admitted/recommended V2 authority facts and exact
    materialization links without deriving eligibility from V1 score or state.
12. Incomplete active/ready V2 lineage is marked `MIGRATION_BLOCKED`; no missing
    evidence is synthesized.

## 18. Gate 2 Verification

| Check                                                   | Result                                             |
| ------------------------------------------------------- | -------------------------------------------------- |
| Focused Gate 2 Vitest matrix                            | 7 files passed; 35 tests passed                    |
| Candidate authority and tenant RLS                      | passed                                             |
| Historical exclusion and duplicate race guards          | passed                                             |
| Zero-cost compatibility lineage                         | passed                                             |
| Staged Phase 9 exact-lineage authorization              | passed                                             |
| Fresh-project Blueprint and V2 input pin                | passed                                             |
| Running-generation recovery and terminal-job non-repair | passed                                             |
| Project-context projection compatibility                | passed                                             |
| Backend TypeScript                                      | passed                                             |
| Backlinks migration validation                          | `83 files through 0091`                            |
| Focused Prettier check                                  | passed                                             |
| `git diff --check`                                      | passed; only existing Windows line-ending warnings |

The normalized-LF SHA-256 for migration `0091` is:

`dfc3e8426e9b594ff58307d939f994c5b6e5cc78e176aa5a771ee250ae7668e8`

The deployment manifest has:

- head: `0091`
- prerequisite: `backlinks-0090`
- stored checksum: exact match

The PostgreSQL fixture verifies `MIGRATION_BLOCKED = 0` for all three projects
claimed ready.

## 19. Remaining Planned Boundaries

The expected-red admission contract remains intentionally outside Gate 2.
Gate 4 owns the admission service and the separation of admission, metrics,
contact preparation and recommendation semantics. Gate 3 owns discovery
planning and bounded provider execution.

Real-provider evidence, deployment evidence and human UAT remain unproven.

## 20. Gate 2 Decision

Gate 2 is `PASS`.

The V2 candidate authority, exact contract lineage, additive V2 pin,
fresh-project Blueprint path, zero-cost canonical bridge, history exclusion,
tenant isolation, migration manifest and terminal-job recovery boundary are
implemented and verified. Execution stops at the Gate 2 boundary.

## 21. Gate 3 Prerequisite Audit

Audit date: `2026-09-03`.

The coding plan states that gate numbers are stable identifiers rather than the
execution order. Section 11 requires Gate 4 V2 admission and canonical
materialization services to pass before Gate 3 can increase paid discovery
breadth or concurrency.

The current prerequisite result is:

| Check                                              | Result                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| Gate 2 decision                                    | `PASS`                                               |
| Gate 4 V2 admission contract                       | `5 failed / 5`; admission authority module is absent |
| Gate 3 DataForSEO executor contract                | `3 passed / 2 failed`                                |
| Distinct durable window per request                | failed; window ordinal is still round-only           |
| Multiple request paths per round                   | failed; executor still contains `maxRequests: 1`     |
| DataForSEO calls during this audit                 | `0`                                                  |
| Authorized or settled provider cost during audit   | `0`                                                  |
| Deployment, real-provider acceptance and human UAT | not entered                                          |

The missing Gate 4 module is:

`backend/core/src/modules/backlinks/domain/recommendations/recommendation-pool-v2-admission.ts`

No Gate 3 production behavior was changed. In particular, the fair planner,
multi-request execution, provider concurrency, request accounting and V2
candidate-yield semantics remain untouched.

## 22. Gate 3 Prerequisite Decision

Gate 3 is `BLOCKED_PREREQUISITE_GATE4`.

Execution stops before Gate 3 implementation. The next authorized coding
package in the plan is Gate 4, followed by Gate 3 after the Gate 4 exit gate
passes.

## 23. Gate 4 Implementation

Implementation date: `2026-09-03`.

Gate 4 adds the native V2 admission boundary and keeps it separate from V1
qualification and score semantics:

1. The admission contract returns only `ADMITTED` or one frozen hard-exclusion
   code from the V2 policy.
2. Nullable or unavailable metrics do not exclude a candidate and no numeric
   score participates in admission.
3. Project context, historical release and existing Opportunity domains are
   checked atomically before admission is persisted.
4. Contact preparation is queued only after admission; missing contact evidence
   does not exclude a candidate.
5. Repeated source and metric observations append immutable evidence while the
   canonical candidate row remains idempotent.
6. Admitted candidates materialize through the V2 compatibility bridge with
   non-`PUBLISHED` inventory, null score and no fabricated fit or email facts.
7. Native V2 discovery returns before V1 progressive qualification, static
   assessment, contact enrichment and refill storage paths.

## 24. Gate 4 Verification

| Check                                      | Result                                      |
| ------------------------------------------ | ------------------------------------------- |
| Expected-red admission contract            | `5 failed / 5`; missing authority confirmed |
| Focused Gate 4 unit/static matrix          | `5 files passed; 22 tests passed`           |
| Candidate authority and materialization DB | `2 files passed; 17 tests passed`           |
| Backend TypeScript                         | passed                                      |
| Focused ESLint                             | passed                                      |
| `git diff --check`                         | passed; Windows line-ending warnings only   |
| DataForSEO calls                           | `0`                                         |
| Provider cost                              | `USD 0`                                     |

Real-provider acceptance, deployment evidence and human UAT remain unproven.

## 25. Gate 4 Decision

Gate 4 is `PASS`.

The prerequisite block recorded in sections 21 and 22 is now resolved. Gate 3
may begin from this verified Gate 4 state.

## 26. Gate 3 Boundary and RED

Implementation date: `2026-09-03`.

Gate 3 started from repository branch `main` at:

`7df8d48d088328bd79fb0a1afef364b17cc8b6af`

The pre-edit checkpoint is:

- `C:\Users\DELL\Documents\缝合\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001-GATE3-PREEDIT-20260903T065003Z`

The initial focused Gate 3 run reproduced the planned gaps:

| Check                              | RED result                  |
| ---------------------------------- | --------------------------- |
| Focused discovery/executor matrix  | `4 files; 9 failed / 52`    |
| Multiple request paths per round   | failed                      |
| Distinct durable request windows   | failed                      |
| Fair deterministic seed planning   | failed                      |
| Exact per-request V2 reconciliation | failed                     |

No real DataForSEO request, deployment, commit, push or durable business-data
mutation was authorized or performed. The shared dirty worktree was preserved.

## 27. Gate 3 Implementation

Gate 3 repairs discovery planning and execution without changing the existing
bounded provider runtime:

1. The native V2 planner now interleaves keyword, product/category, competitor,
   audience, pattern and market/language dimensions deterministically instead
   of taking a subject-first flat slice.
2. A native discovery round returns a collection of per-request results and can
   select up to four request paths through the existing bounded concurrency
   setting.
3. Request selection enforces the remaining persisted round authorization and
   never exceeds the frozen USD 1 round ceiling. Generation launch uses the
   frozen 25-request operational maximum while the database continues to
   enforce USD 1 per round and USD 2 per generation.
4. Every selected request records its immutable V2 intent before provider
   execution and receives a separate deterministic request, reservation, actor,
   idempotency and window identity.
5. A completed provider request or reusable provider artifact is replayed
   without another provider authorization or billable execution.
6. Candidate ingestion returns exact `raw`, canonical-deduped, `newUnique`,
   canonical duplicate, admitted and hard-excluded counts. Raw duplicate
   observations remain derivable as `raw - canonical`.
7. First-run admission counts are reconciled with persisted candidate/source
   facts before outcome persistence. Retry counts are independently reconciled
   with the immutable request outcome before a window can be recorded.
8. Scheduling stops when the 100-admitted supply target, 1,000 admitted hard
   ceiling, 2,500 raw-observation ceiling, request ceiling or remaining durable
   authorization is reached.
9. Round comparison records `KEYWORD` only when the keyword fingerprint really
   changed; request serialization changes no longer create a false dimension.
10. Multiple immutable windows per round are accepted while stale lower
    request/window ordinals remain rejected.

## 28. Gate 3 Verification

| Check                                      | Result                                             |
| ------------------------------------------ | -------------------------------------------------- |
| Final focused Gate 3 unit/static matrix    | `7 files passed; 78 tests passed`                   |
| Discovery ledger/schema integration        | `2 files passed; 28 tests passed`                   |
| Backend TypeScript                         | passed                                             |
| Focused ESLint                             | passed                                             |
| Production static single-request scan      | no `maxRequests: 1` or fixed one-request window    |
| Scoped `git diff --check`                  | passed; Windows line-ending warnings only          |
| Real DataForSEO calls                      | `0`                                                |
| Authorized or settled real-provider cost   | `USD 0`                                            |
| Deployment / real-provider acceptance      | not entered                                        |
| Human UAT                                  | not entered                                        |

An adjacent workflow-contract run completed `84/87` tests. Its three remaining
expected-red assertions are owned by Gate 5:

- zero valid candidates must project completed exhaustion rather than
  `INPUT_REQUIRED`;
- 1-99 admitted candidates must project `partial_exhausted`;
- unexpected workflow/provider failure must return a durable `failed` result.

Those Gate 5 contracts were not masked or changed during Gate 3.

Final SHA-256 values for the main Gate 3 production files:

| File | SHA-256 |
| ---- | ------- |
| `commercial-recommendation-discovery.service.ts` | `8e805b3e8cbe26016e66cf2438a4c6606cd8dc16809dec7f1c8b013c332bbf0f` |
| `recommendation-pool-v2-candidate-admission.service.ts` | `0c834b972915efcc52dcaa56fd09634be1a4c15b75791e43dad0b25ec6f8d3f5` |
| `recommendation-pool-v2-discovery-finalizer.service.ts` | `f34b49651119e5fcf59690e5abf9576a5cfacd57dbb03205bc26eb46bac38e5e` |
| `recommendation-pool-v2-generation-launcher.service.ts` | `a75d482a7542b196720a1b02b5dfca6f4443bb20a9ccfd04ff2c2beee406b982` |
| `recommendation-pool-v2-generation-launch.repository.ts` | `e19a02335d1d820ab79610c50e1ab06700e5345f2e5d711f2d17a668a180d2c7` |
| `recommendation-pool-v2-policy.ts` | `e83d45ce1767d5ccce7be609e8f565569ab9757f312a86919de8ee63b73c9cc4` |
| `recommendation-pool-v2-dataforseo-executor.ts` | `83c13cbe0f2d92c82c5045a4e0324c99579c19bedda1d0587fb5218edb8676b8` |

## 29. Gate 3 Decision

Gate 3 is `PASS`.

The fair planner, multi-request result contract, per-request durable authority,
bounded execution, exact V2 yield accounting, replay protection, stop ceilings
and changed-dimension semantics are implemented and locally verified.
Execution stops at the Gate 3 boundary. Gate 5 terminal projection remains the
next planned coding boundary.

## 30. Gate 7 Temporal-Safety Boundary

Implementation date: `2026-09-03`.

The coding plan's immediate implementation order requires the Temporal-safety
part of Gate 7 before Gate 5 changes workflow terminal control flow. This work
therefore implements the Gate 7 replay and durable timing prerequisites only.
It does not claim the full real-sample Gate 7 exit gate.

The pre-edit source checkpoint is:

`C:\Users\DELL\Documents\缝合\john3947-seo-main\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001-GATE7-PREEDIT-20260903T080649Z`

The checkpoint contains 24 scoped source files plus the ownership ledger.
The shared dirty worktree was preserved.

Before applying the new database migrations, the local PostgreSQL backup was:

- path:
  `C:\Users\DELL\AppData\Local\GrowthOS\live001\backups\GATE7-PRE0091-0092-20260903T083248Z.dump`
- size: `100046862` bytes
- SHA-256:
  `1E717204F6CC8353BDF72BC581A9CB2961FC5DCE85EFAE588DAE323ADEBF42EF`

No fresh recommendation generation, DataForSEO request, deployment, commit or
push was authorized or performed.

## 31. Gate 7 Timing and Replay Implementation

Gate 7 adds append-only V2 timing evidence with correlation by organization,
workspace, project, command, generation, round, request intent and candidate.
The durable timing vocabulary covers:

- command accepted and workflow scheduled/started;
- seed snapshot and request planning;
- provider queue, execution and outcome persistence;
- candidate normalization, admission and metric enrichment;
- contact preparation, batch preparation and publication.

Frontend first-observed timing remains a defined vocabulary boundary but is not
wired in this subgate because the route/client/UI lifecycle belongs to Gate 6.

The workflow uses patch marker:

`backlinks-recommendation-pool-v2-terminal-semantics-v2`

This marker protects the later Gate 5 control-flow change while existing
histories still replay the old branch. Two real local Temporal histories were
captured as immutable fixtures:

- completed:
  `completed-01a063f6-c76a-7f3e-8b4e-4fee861c1b73.json`
- failed:
  `failed-01a0630d-0744-7246-86e1-890400c7aa75.json`

Both histories replay against the new workflow bundle.

## 32. Gate 2 Runtime Reconciliation Correction

Applying migration `0091` to the current FORCE RLS database exposed a defect
that the repository fixture had not reproduced. The migration executes as
`growthos_backlinks_owner`; FORCE RLS hid cross-tenant rows from
`backlink_generation_input_pins`, so the reconciliation update saw no source
pins and left seven incomplete project contracts active/ready.

Applied migration `0091` was not edited. Forward migration `0093` now:

1. locks project contracts, generation contracts and generation input pins;
2. temporarily removes FORCE RLS from all three tables inside one transaction;
3. runs the exact candidate-fact reconciliation;
4. asserts that no incomplete active/ready contract remains;
5. restores FORCE RLS before commit;
6. installs a verification marker covering the reconciliation, all three RLS
   states and the V1-write freeze.

The repaired current database state is:

| Check | Result |
| --- | --- |
| `MIGRATION_BLOCKED` project contracts | `7` |
| Updated by `backlinks-0093` | `7` |
| Reason `V2_CANDIDATE_LINEAGE_INCOMPLETE` | `7` |
| Incomplete `V2_READY` / `V2_ACTIVE` contracts | `0` |
| Project-contract FORCE RLS | enabled and forced |
| Generation-contract FORCE RLS | enabled and forced |
| Input-pin FORCE RLS | enabled and forced |
| Owner update without tenant context | `UPDATE 0` inside rolled-back probe |
| V1 writes frozen | `true` |

This forward correction supersedes the migration-readiness portion of the
earlier Gate 2 decision. Candidate authority code remains unchanged; the defect
was the live reconciliation execution context.

## 33. Gate 7 Verification and Runtime Handoff

| Check | Result |
| --- | --- |
| Gate 7 focused matrix | `5 files passed; 11 tests passed` |
| Real-history replay fixtures | `2 passed` |
| Timing and 0093 migration contracts | passed |
| Backend TypeScript | passed |
| Focused ESLint | passed |
| Backlinks migration validation | `85 files through 0093` |
| Build identity check | passed |
| Scoped `git diff --check` | passed; Windows line-ending warnings only |
| Running V2 Temporal workflows | `0` |
| Workflow task-queue backlog | `0` |
| Activity task-queue backlog | `0` |

The local runtime was rebuilt and handed off from:

`local-product-fda42f1839c0a35d82c4480e`

to:

`local-product-921e967e2a0e45ea5cc624ae`

The new API PID is `54016`; the new Worker PID and active Temporal poller
identity are `42868` and `42868@DESKTOP-C9194QL`. The previous API/Worker
processes `37816` and `29060` are stopped. Temporal still reports the previous
poller as a stale last-access row for a short retention interval, but it is no
longer a live process. Task-queue versioning remains disabled and the CLI
therefore reports `UNVERSIONED`; exact build identity is verified by API,
Worker and Platform health instead.

After restarting Platform with the new expected build,
`/api/v1/runtime-status` reports:

- `status=ok`;
- `mode=PRODUCT`;
- `build.current=true`;
- API and Worker build IDs equal the expected build;
- Worker execution mode `normal`;
- PostgreSQL and Temporal ready;
- business consumers and project-context dispatcher running.

The frontend responds with HTTP `200` through its configured `localhost`
binding on `::1`. It is not bound to `127.0.0.1`.

Provider and recommendation-pool counts were identical immediately before and
after the runtime handoff:

| Durable row count | Before | After |
| --- | ---: | ---: |
| Provider batch requests | 201 | 201 |
| Provider requests | 239 | 239 |
| Provider usage ledger | 224 | 224 |
| Generation contracts | 32 | 32 |
| Gate 7 timing events | 0 | 0 |

The zero timing-event count is expected: this subgate deliberately launched no
fresh generation under the zero-provider-call ceiling. Existing unrelated
Gmail polling retries were observed after Worker restart, but they did not
change DataForSEO/provider accounting and are not Gate 7 evidence.

Main Gate 7 file hashes:

| File | SHA-256 |
| --- | --- |
| `recommendation-pool-v2-timing.repository.ts` | `2755cb0d4abaacdc253aa15df18d1f7bdbc5fd716f0314a89142f6ab2d000323` |
| `recommendation-pool-v2.workflow.ts` | `764bd96255249d048599bdef4b5971b97c1999ccf055c5cdc326587b39bed9ee` |
| `0092_backlink_recommendation_pool_v2_timing.sql` | `53a02720321904f8341e5667b34e64e28dc63197ba8bbde34f219fdccd5fd6a4` |
| `0093_backlink_recommendation_pool_v2_candidate_fact_reconciliation.sql` | `8b5777cf9984dfe9d8a1d89572b582b6f52e539a6739ed43d6b91db828246eca` |

## 34. Gate 7 Decision and Next Boundary

The Gate 7 Temporal-safety and durable timing subgate is
`PASS_LOCAL_TEMPORAL_SUBGATE`.

The full Gate 7 real-sample exit gate remains
`FULL_GATE7_REAL_SAMPLE_PENDING` because no paid sample was launched, no timing
distribution exists yet, the largest product-controlled real-sample span has
not been measured, and frontend first-observed instrumentation remains owned by
Gate 6.

The Gate 5 workflow contract remains intentionally red at exactly three
assertions:

- zero valid candidates currently return `input_required` instead of completed
  exhaustion;
- 1-99 admitted candidates currently return `completed` instead of
  `partial_exhausted`;
- unexpected workflow failure currently rejects instead of returning a durable
  `failed` result.

The focused Gate 5 run is `12 passed / 3 failed`. These are the next authorized
coding changes. With the Gate 7 Temporal prerequisite and the 0093 live
reconciliation repair complete, the next coding boundary is now Gate 5.

## 35. Gate 5 Boundary and Checkpoint

Implementation date: `2026-09-03`.

Gate 5 was limited to terminal, low-yield, failure, immutable-generation and
atomic project-contract rotation semantics. It did not enter Gate 6 historical
entitlement, seed preview/confirmation, gateway, OpenAPI, generated-client or
frontend lifecycle work.

The pre-edit checkpoint is:

`C:\Users\DELL\Documents\缝合\john3947-seo-main\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001-GATE5-PREEDIT-20260903T094208Z`

The start identity was branch `main` at
`7df8d48d088328bd79fb0a1afef364b17cc8b6af`. The shared dirty worktree was
preserved. No commit, push, deployment, migration application, real provider
call or real Temporal business workflow was performed.

The expected-red workflow baseline was `12 passed / 3 failed`:

- zero valid candidates incorrectly returned `input_required`;
- 1-99 admitted candidates incorrectly returned `completed`;
- unexpected execution failure rejected instead of returning a durable failed
  projection.

## 36. Gate 5 Implementation

The workflow and repository now enforce the following state rules:

| Condition | Persisted and returned result |
| --- | --- |
| Missing or invalid seeds | `INPUT_REQUIRED`; discovery is not invoked |
| Provider or internal failure | `FAILED` with durable retryability |
| 100 admitted candidates | `READY` publication |
| 1-99 admitted after bounded exhaustion | publication plus `PARTIAL_EXHAUSTED` |
| Zero valid after bounded exhaustion | operational success plus `NO_VALID_CANDIDATES_AFTER_EXHAUSTION`; no publication or old-pool replacement |
| All entitled prepared batches consumed | `POOL_EXHAUSTED` |

The old Temporal branch remains replay-compatible behind
`backlinks-recommendation-pool-v2-terminal-semantics-v2`. Unpatched histories
retain the legacy zero-valid activity call and failure behavior.

Generation activation validates the admitted count against the requested
publication outcome. In one transaction it locks the current project contract,
requires a completed higher generation with matching immutable lineage, makes
the first canonical batch available, creates the user publication and cursor,
rotates the project contract and completes the job projection. A failed row
count aborts the transaction.

The recovery path derives `READY` or `PARTIAL_EXHAUSTED` from the persisted
generation count and terminal reason. It also requires and reuses the persisted
workflow identity when a job is present.

Job execution, discovery result, contact preparation and release result are no
longer collapsed into one terminal label. A successful zero-valid run is stored
as job success while exposing the product outcome and discovery reason
separately. Failure stores code, message and retryability. Successful
publication stores admitted and released counts plus `AVAILABLE`.

Release/status contracts now return `POOL_EXHAUSTED`. Historical idempotency
rows containing `NO_MORE` remain readable and are normalized to
`POOL_EXHAUSTED`; no new backend response emits `NO_MORE`.

The integration fixtures were also aligned with the already-installed Gate 4
candidate-fact contract:

- V2 generation/input-pin contract versions are exact;
- native release items carry `generation_candidate_id`;
- pool exhaustion is asserted on both first execution and idempotent replay;
- the atomic-rotation test snapshots the old terminal generation before
  activation and proves it is unchanged after the higher generation becomes
  active.

## 37. Gate 5 Verification

| Check | Result |
| --- | --- |
| Gate 5 workflow contract | `17 passed` |
| Focused unit/API/replay/migration-static matrix | `6 files; 34 passed` |
| Temporal historical replay | `2 histories replayed` |
| Isolated database behavior through migration 0092 | `3 files; 13 passed` |
| Backend TypeScript | passed |
| Focused ESLint | passed |
| Scoped `git diff --check` | passed |
| Real DataForSEO/provider calls | `0` |
| Authorized or settled real-provider cost | `USD 0` |
| Deployment / real-provider acceptance | not entered |
| Human UAT | not entered |

The isolated database verification covered:

- zero-valid, failed and orphan-generation terminal projection;
- partial publication, first-batch availability, job projection, recovery and
  old-generation immutability;
- canonical Opportunity creation and idempotent `POOL_EXHAUSTED`.

Fresh-database tests using the full current deployment manifest remain blocked
before fixture setup by migration `0093`. The exact prerequisite report is:

`Recommendation pool V2 candidate fact reconciliation failed:
{"v1WritesFrozen": false, "inputPinsForceRls": true,
"projectContractsForceRls": true, "generationContractsForceRls": true,
"candidateFactReconciliationInstalled": true}`

The same pre-test failure was reproduced in the seed, canonical-batch and
Opportunity integration suites. Migration `0093` intentionally requires the
V1-write freeze, while the clean integration harness applies the entire
manifest before installing that runtime freeze state. Gate 5 did not edit the
already-applied migration or manufacture freeze state to bypass the check.

Main Gate 5 production file hashes:

| File | SHA-256 |
| --- | --- |
| `recommendation-pool-v2-workflow.service.ts` | `331b5b9d0e6094571c058bce0ca2331a6329730b2d1dae80bbe196fb418a2dd1` |
| `recommendation-pool-v2.repository.ts` | `4ae72ea9cf512af6f65e48957957488beb16f784648756df4c3a5a69937a7772` |
| `recommendation-pool-v2-generation-launch.repository.ts` | `3033a02550f9be5f3c19becc8ba018e3fefc970891ddfac1c4e988a29035b51b` |
| `recommendation-pool-v2.activity.ts` | `dbf9c3f16acaa62e69cbed2289d12e83efd45eb54394e0c31d587ddf76dd8402` |
| `recommendation-feed.command.ts` | `346cf968142ba2cac40b3bdbf83fa2bc072c0d308f82da7a37efce1bcdfc7fbb` |
| `recommendation-user-release.service.ts` | `255a6b192fa15d751bbd94bfdf7ed499f4be35054cf431ba75687a6e362c94c5` |
| `recommendation-user-release.command.ts` | `1ed283e136832b1aa2436845577f480bbda92e544d53d83e9c8ac5e6a4a4224b` |
| `recommendation-user-release.route.ts` | `35849cafd8c953de50300ae6179a860ced8a743e9af2c6316d71ea3a2c06d91c` |
| `recommendation-user-release.repository.ts` | `01616fb1e60573942fa1cfb67505f554b2f34acea875fe36806ee1db1a4c817` |

## 38. Gate 5 Decision and Stop Point

Gate 5 production behavior is
`IMPLEMENTED_AND_LOCALLY_VERIFIED_THROUGH_0092`.

The full gate is `FULL_MANIFEST_INTEGRATION_BLOCKED`, not an unconditional
`PASS`, because the current clean-database bootstrap cannot cross migration
`0093` and therefore cannot execute the formal Gate 5 integration assertions
under the complete manifest.

The next execution boundary is not automatically Gate 6. First repair or
authorize the fresh-database V1-freeze bootstrap required by `0093`, rerun the
three formal integration suites through the full manifest, and only then decide
whether Gate 5 can be promoted to `PASS`.

## 39. Gate 5 0093 Fresh/Upgrade Ownership Decision

Resolution date: `2026-09-04`.

Task:
`BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-5-0093-FRESH-UPGRADE-BOOTSTRAP-001`.

The pre-edit ownership ledger is:

`C:\Users\DELL\Documents\缝合\john3947-seo-main\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-5-0093-FRESH-UPGRADE-BOOTSTRAP-001-PREEDIT-20260903T143440Z\ownership-ledger.md`

Decision B applies. Migration `0093` was created and applied by the prior
authorized Gate 7 work to the authoritative local product database. It is
therefore immutable in this task and remains byte-for-byte unchanged at:

`8b5777cf9984dfe9d8a1d89572b582b6f52e539a6739ed43d6b91db828246eca`

The deployment-manifest entry also remains unchanged and matches that exact
checksum. The Backlinks manifest head is `0093`, its migration ID is
`backlinks-0093`, and its prerequisite is `backlinks-0092`.

The repair is implemented before `0093` in the formal production migration
runner. `scripts/dev-up.ps1` now consumes the checksum-verified renderer instead
of enumerating Backlinks SQL files directly. The runner composes the bootstrap
and immutable `0093` body into one database transaction.

The bootstrap may establish the existing durable V1-write freeze only when:

- the caller is a database operator;
- `platform.projects` is empty;
- every existing ordinary or partitioned table in `backlinks` is empty;
- the cutover verifier reports zero eligible, active V2, migration-blocked,
  active V1 generation, refill, refill-job, outbox, claim, provider-request,
  reservation and lease state.

The check holds an advisory transaction lock plus access-exclusive locks on the
project and Backlinks tables. Any non-pristine unfrozen database raises
`BACKLINKS_0093_FRESH_BOOTSTRAP_REQUIRES_PRISTINE_DATABASE` before mutation.
An already frozen upgrade must still pass the existing Phase 9 verification.

## 40. Full-Manifest Database Gate

The final disposable run used an isolated PostgreSQL `17.10` cluster on port
`65434`. The default test harness remains pinned to PostgreSQL 18; the external
admin mode was used because Docker Desktop's Linux-engine API returned HTTP
500. No Docker or product service restart was attempted.

All final database evidence is later than the latest touched code/test mtime,
`2026-09-04 10:53:25.570 +08:00`.

| Check | Result |
| --- | --- |
| Migration checker | `85 files through 0093`; passed |
| Manifest file SHA-256 | `8da4f89af2914a3f359ba1042744e74af72f9c24e526b05e07f47a3878494f82` |
| `0093` manifest/file checksum | exact match |
| Pristine install | Backlinks `0001` through `0093`; passed |
| Fresh durable freeze audit | cutover run, Phase 9 run and control fact present |
| Non-pristine upgrade with valid pre-freeze | passed; existing business fact preserved |
| Non-pristine unfrozen upgrade | failed closed with the expected error and exact pre/post state equality |
| `0093` idempotent rerun | passed with exact pre/post state equality |
| Session `search_path` | unchanged |
| Reconciliation privileges | PUBLIC revoked; writer and reporting grants present |
| Candidate-contract RLS | all three target tables have RLS and FORCE RLS |
| Seed, canonical-batch and Opportunity full-manifest suites | `3 files; 13 passed` |

The fresh/upgrade matrix itself passed `1 file; 3 tests` at `2026-09-04
10:55:11 +08:00`. The three previously blocked suites passed `3 files; 13
tests` at `2026-09-04 10:54:30 +08:00`. Both use the same production manifest
runner as the `dev-up.ps1` execution path.

The disposable cluster was stopped and removed after verification. Ports
`65432`, `65433` and `65434` had no remaining listener.

## 41. Final Gate 5 Verification

| Check | Final result |
| --- | --- |
| Gate 5 workflow contract | `17 passed` |
| Focused unit/API/replay/migration matrix | `6 files; 34 passed` |
| Temporal replay | `2 histories replayed` |
| Full-manifest database suites | `3 files; 13 passed` |
| Fresh/upgrade manifest matrix | `1 file; 3 passed` |
| Core TypeScript | passed |
| Focused ESLint for every touched JS/TS/MTS file | passed |
| Focused Prettier check for every touched supported file | passed |
| `scripts/dev-up.ps1` parser check | passed |
| Tracked and untracked scoped `git diff --check` | passed |
| Real provider calls | `0` |
| Real provider cost | `USD 0` |
| Gate 6 production call edge introduced by this task | `0` |

Main blocker-resolution hashes:

| File | SHA-256 |
| --- | --- |
| `deployment-manifest-runner.mjs` | `74f701d13c6e1846b5e2aa6a7a330815caeb3105ebfa5f4be2b309b6c061d3bb` |
| `0093_pristine_v1_freeze_bootstrap.sql` | `43f4223b520ecce45fd02690d0ee87a752ea89ee098ee007df51b54b1dd168ff` |
| `render-backlinks-deployment-manifest.mjs` | `faa5b42bd3187e7390b203821901e12d9df0bb3a6af23c04af33dab457dc0072` |
| `deployment-manifest-runner.d.mts` | `fd314bb2e6b2954b8460047e276da0ed0e63981ffa4c375d6ae33ab0e7a82807` |
| `postgresql-container.ts` | `e2d47ee79d5fb2dfe82324c807530b5a13ac405f4c84fa15f7430a19d57d9907` |
| `recommendation-pool-v2-deployment-manifest-runner.test.ts` | `da4e37b61b55ec190cc718ffff3d2e4644e6bac8720d59c29ad323d548dd186e` |

No product database migration or manual SQL, product service lifecycle change,
real Provider/Gmail/browser call, Gate 6 implementation, commit, push or deploy
was performed.

## 42. Gate 5 Final Decision and Stop Point

Gate 5 is `GATE_5_PASS_READY_FOR_SUPERVISOR_REVIEW`.

Execution stops at the Gate 5 boundary. Gate 6 is not entered.

## 43. Gate 6 Feed Entitlement and Seed Lifecycle

Execution date: `2026-09-04`.

Task:
`BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-6-001`.

The pre-edit ownership ledger is:

`C:\Users\DELL\Documents\缝合\john3947-seo-main\.codex-checkpoints\BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-6-001-PREEDIT-20260904T042012Z\ownership-ledger.md`

The feed now returns all V2 release items in active publications entitled to
the actor across historical generations. Archive state, permanent exclusion,
filters, search, sort and cursor processing remain server-side. The response
keeps two separate projections:

- `releasedPool` reports the usable historical generation count and range;
- `latestGeneration` reports the newest V2 generation state, progress, counts,
  terminal reason and retry safety.

Seed handling is split into preview, exact snapshot confirmation and launch.
Confirmation persists the edited non-empty seed set. Launch requires its exact
generation contract, snapshot fingerprint and idempotency key; an implicit
empty seed set cannot reach generation execution.

The frontend exposes generated keyword, category and SEO-competitor seeds for
keyboard-editable review. It keeps the old released pool usable while a newer
generation is active, polls both projections every 2.5 seconds only while the
generation is non-terminal, and renders the raw terminal outcome, including
`PARTIAL_EXHAUSTED`, without converting it to generic failure or
`INPUT_REQUIRED`.

Core schemas were propagated through the Backlinks OpenAPI source, aggregate
platform contract, Python gateway tests and generated frontend client.

## 44. Gate 6 Current-Code Verification

The latest Gate 6 production-code mtime was `2026-09-04
13:59:18.795 +08:00`. Every result below was obtained after that time.

| Check | Final result |
| --- | --- |
| Core feed/seed/launcher focused matrix | `6 files; 23 passed` |
| Full-manifest disposable database suites | `3 files; 12 passed` |
| Frontend API/hook/workspace matrix | `3 files; 14 passed` |
| Python gateway matrix | `39 passed` |
| Desktop/mobile Playwright | `4 passed`; one worker |
| Keyboard seed review and launch | passed in both browser projects |
| Historical release remains usable during new generation | passed |
| Empty implicit launch | rejected; no request emitted |
| Terminal polling stop and `PARTIAL_EXHAUSTED` projection | passed |
| Provider/workflow browser request edge | `0` |
| Core TypeScript | passed |
| Frontend TypeScript and V2 contract | passed |
| Backlinks OpenAPI | `91 paths`; passed |
| Aggregate shared contract | `253 paths`, `283 operations`; passed |
| Generated frontend client | `93 operations`; passed |
| Migration checker | `85 files through 0093`; passed |
| Scoped Core/frontend ESLint and Prettier | passed |
| Changed Python gateway-test Ruff lint | passed |
| Tracked diff and untracked whitespace checks | passed |
| Real provider calls / cost | `0 / USD 0` |
| Product database writes | `0` |
| Gate 8 production call edge | `0` |

The Python gateway production file remained Git-clean in this task. A
whole-file Ruff formatter pass was not applied to the modified gateway test
because it would normalize unrelated historical line endings and formatting
outside the owned route-test hunk; semantic Ruff lint and all 39 gateway tests
passed.

The database tests used the formal production migration runner against an
isolated PostgreSQL `18.6` instance on `127.0.0.1:65432`. The instance and data
directory were removed after verification. Ports `65432` and `4196` had zero
remaining listeners. Docker, WSL, product services and project runtime
configuration were not changed.

Main Gate 6 production hashes:

| File | SHA-256 |
| --- | --- |
| `recommendation-feed.query.ts` | `553a15494cf401c7ffc5d92fbb1e6a89d677e7ea511fb83fad4522a2fa83ab5d` |
| `recommendation-feed.repository.ts` | `7229709dba2a72f02d8cde0859ce9024f89480a5c13d949aecd1f5369cbd65b2` |
| `recommendation-seeds.command.ts` | `f71fd8aca8fd31203fd8cfd488ebfe94b47d4cf71102444e9c680a25e5758d24` |
| `recommendation-pool-v2-generation-launcher.service.ts` | `dc3ef4dea53606c4d2508ffc51d41051bfe6d9281e15dc292f7569d63e5b65a0` |
| `recommendation-feed-workspace.tsx` | `085434f5c0b576de311efca0fc1077d5bb95c5784f9017435b5f4bf1c5d42929` |
| `frontend/src/api/generated/backlinks.ts` | `f988df69865ca6a409617bbefaf00ccbf26514e42a248ce8df2b57702370c4b5` |
| `backlinks.v1.json` | `7626f04d52129850991d522e57f52ab6fd735453fd7b847e6c78aabd3fba4e70` |
| `platform.v1.json` | `d22bfaef540f1b59d1d7d8c5ac4e1ae31a68a2a128c0813a25fe68e1090593f2` |

## 45. Gate 6 Decision and Stop Point

Gate 6 is `GATE_6_PASS_READY_FOR_SUPERVISOR_REVIEW`.

Execution stops at the Gate 6 boundary. Gate 8, real-provider acceptance,
product-database apply, service lifecycle changes, commit, push and deploy were
not entered.

## 46. Gate 8 Full Local Verification

Execution date: `2026-09-04`.

Task: `BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-8-001`.

The ownership ledger and raw command logs are under:

`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-8-001-PREEDIT-20260904T061512Z`

The latest Gate 8 code/test mtime was `2026-09-04
18:39:52.5676122 +08:00` in
`frontend/test/support/outreach-api-fixtures.ts`.

Gate 8 corrected only reproduced verification defects:

- map the generated V2 exhausted state as `POOL_EXHAUSTED` and complete the
  typed feed fixtures;
- use the formal deployment-manifest runner in full-head database fixtures and
  stop historical migration fixtures at their intended migration boundary;
- support an explicitly supplied disposable Temporal address in the
  integration harness;
- isolate Playwright and standalone source-contract suites from Vitest;
- make the dated content-plan fixture deterministic;
- correct the direct-license and locked-version SBOM assertions.

| Check | Result |
| --- | --- |
| Core `verify:backlinks` | passed |
| Core unit | `184 files; 1231 passed` |
| Core API | `36 files; 159 passed` |
| Core contract | `28 files; 203 passed` |
| Core full integration | `76 passed, 4 skipped files; 375 passed, 14 skipped tests` |
| Core security | `9 files; 114 passed` |
| Core resilience | `3 files; 8 passed` |
| Backlinks OpenAPI / migrations | `91 paths`; `85 files through 0093`; passed |
| Disposable Temporal interruption/recovery | `1 passed` |
| Full-manifest repeatability | `3 files; 12 passed`, twice |
| Python gateway | `39 passed` |
| Frontend typecheck | passed |
| Generated client / V2 contract | `93 operations`; passed |
| Frontend Vitest | `93 files; 596 passed` |
| Frontend desktop Playwright | `10 passed` |
| Frontend mobile Playwright | `2 passed` |
| Frontend keyboard accessibility Playwright | `1 passed` |
| Frontend production build | passed |
| Gate-owned Core/frontend ESLint | passed |
| Scoped tracked `git diff --check` | passed |
| Real provider calls / cost | `0 / USD 0` |
| Gate 9 production call edge | `0` |

The database and Temporal verification used isolated listeners
`127.0.0.1:65432` and `127.0.0.1:17233`. Both were stopped after verification;
the PostgreSQL state and cluster directory were removed. Disposable frontend
ports `4196` and `4197` were also closed. Product listeners and PIDs on
`5432`, `7233`, `7200`, `7301` and `5173` remained unchanged.

## 47. Gate 8 Remaining Blockers

Gate 8 cannot satisfy its exit gate for four independently reproduced reasons:

1. Core `npm run test:backlinks:e2e` exits `1` because `playwright` is not
   installed in Core. The same script exists at `HEAD`; Core has no Playwright
   configuration and zero Core `*.spec.ts` or `*.spec.tsx` suites. This is a
   pre-existing nonfunctional command, not a failure in the Gate 8 V2 code.
2. Full frontend `npm run lint` exits nonzero with `15 errors` and `2 warnings`
   in content, Gmail, links, performance, projects and settings files outside
   the Gate 8 ownership ledger.
3. Whole-file Prettier checks fail in four Core files and two frontend files
   that contain prior unformatted work outside the exact Gate 8-owned hunks.
   Gate-owned ESLint and whitespace checks pass; Gate 8 did not normalize
   unrelated file content to manufacture a green result.
4. The approved product runtime reports `status=unavailable`,
   `worker.process_running=false`, `worker.reason_code=worker_unavailable` and
   missing worker build identity. A direct Temporal health check to
   `127.0.0.1:7233` is actively refused. Therefore Gate 8 cannot prove the
   intended worker poller or one shared UI/API/database generation. Starting
   the product worker was not attempted because product providers are
   configured and service lifecycle/provider execution was outside this
   zero-provider Gate.

No product database SQL or migration apply, product service lifecycle change,
real provider/Gmail/browser call, Gate 9 work, commit, push or deployment was
performed.

## 48. Gate 8 Decision and Stop Point

Gate 8 is
`BLOCKED_AT_GATE_8_RUNTIME_AND_BASELINE_COMMANDS`.

The single next decision is whether to authorize a separate Gate 8 baseline
and runtime remediation scope that owns the unrelated frontend
lint/whole-file-format baseline, defines a real Core E2E entrypoint, and permits
a controlled product-runtime restart with an explicit zero-provider interlock;
alternatively, the Gate 8 exit contract must be amended to accept the isolated
disposable-runtime and frontend Playwright evidence already obtained.

Execution stops at Gate 8. Gate 9 is not entered.

## 49. Gate 8 Authorized Remediation

Execution date: `2026-09-04`.

Task: `BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-8-001`.

The user authorized a controlled Gate 8 remediation of the four blockers in
Section 47, with the fourth product-runtime blocker as the priority. The
remediation retained an explicit loopback-only network interlock and configured
DataForSEO, browser, AI and Gmail provider availability as `explicit_block`.

| Previous blocker | Remediation result |
| --- | --- |
| Core E2E entrypoint | Core now delegates to the maintained frontend Backlinks Playwright suites; desktop and mobile execution passed `4/4` |
| Frontend ESLint | Full frontend `npm run lint` passed |
| Six whole-file Prettier failures | All six originally failing files passed package-local Prettier checks |
| Product runtime and Temporal worker | Platform, Core API, worker, frontend and Temporal became healthy; the expected worker poller was present |

The latest remediated source/test mtime was `2026-09-04 20:35:37 +08:00`.
Every final verification result below was produced after that timestamp.

The repository-wide frontend format baseline still contains historical files
outside this remediation scope. Gate 8 does not require a global frontend
format check; the six reproduced formatting blockers and all files touched by
this remediation pass their scoped checks.

## 50. Gate 8 Product Runtime and Durable-State Evidence

The product runtime was restored through the repository's formal development
startup path, using a temporary environment copy and the loopback-only network
interlock. The original `deploy/compose/.env` remained unchanged with SHA-256
`EA2FA7896354335191D29044C40F53EBE37767B05E32DF60EBB603E0B3EFD377`;
the temporary environment file was removed.

Final runtime observations:

- Platform `7200`, Core API `7301`, worker `7302` and frontend `5173` returned
  healthy responses.
- Core API and worker reported the same build identity
  `local-product-09d2bd66421e4f309a71b3a2`.
- Temporal task queue `growthos.backlinks.v1` had workflow and activity pollers
  under identity `53144@DESKTOP-C9194QL`, with backlog `0`.
- DataForSEO, browser, AI and Gmail all reported
  `externalAvailability=unavailable` with `reason=explicit_block`.
- The disposable final database listener on `55434` and all Gate 8 disposable
  containers were removed after verification.

A final product-database inspection ran in a read-only transaction. It proved:

- durable V1-write freeze is valid;
- active V1 project, generation, refill, job, outbox, claim, provider request,
  reservation and lease counts are all `0`;
- all seven eligible product projects remain fail-closed as
  `MIGRATION_BLOCKED` with reason `V2_CANDIDATE_LINEAGE_INCOMPLETE`;
- no new provider ledger or provider batch timestamp was created during this
  remediation, and Provider calls/cost remained `0 / USD 0`.

The seven `MIGRATION_BLOCKED` projects were not changed or bypassed. They are a
truthful product-data lineage condition, not the former runtime outage, and no
Gate 9 sample-acceptance claim is made from them.

## 51. Gate 8 Final Verification

| Check | Final result |
| --- | --- |
| Core `verify:backlinks` on disposable PostgreSQL | passed |
| Core typecheck / ESLint | passed |
| Core unit | `184 files; 1231 passed` |
| Core API | `36 files; 159 passed` |
| Core contract | `28 files; 203 passed` |
| Core integration | `76 passed, 4 skipped files; 375 passed, 14 skipped tests` |
| Core security | `9 files; 114 passed` |
| Core resilience | `3 files; 8 passed` |
| OpenAPI / migration manifest | `91 paths`; `85 files through 0093`; passed |
| Core Backlinks E2E entrypoint | desktop/mobile `4 passed` |
| Temporal replay | two captured histories replayed; passed |
| V2 feed full-manifest database suite | `3 passed` |
| Python Backlinks gateway | `39 passed` |
| Frontend typecheck / full ESLint | passed |
| Generated client / V2 contract | `93 operations`; passed |
| Frontend Vitest | `93 files; 596 passed` |
| Frontend desktop Playwright | `10 passed` |
| Frontend mobile Playwright | `2 passed` |
| Frontend keyboard accessibility Playwright | `1 passed` |
| Frontend production build | passed |
| Original six-file Prettier scope | passed |
| Scoped `git diff --check` | passed |
| Product runtime / Temporal poller | healthy / present |
| Real Provider calls / cost | `0 / USD 0` |
| Gate 9 production call edge | `0` |

The principal final logs are retained under
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-8-001-PREEDIT-20260904T061512Z`,
including:

- `core-verify-dedicated-postgres-final-20260904.log`;
- `product-runtime-remediation-final-20260904.log`;
- `temporal-replay-two-histories-final-20260904.log`;
- `recommendation-feed-phase6-db-final-20260904.log`;
- `product-db-readonly-final-20260904.log`.

## 52. Gate 8 Final Decision and Stop Point

Gate 8 is
`GATE_8_PASS_READY_FOR_SUPERVISOR_REVIEW`.

Execution stops at Gate 8. Gate 9 was not entered. No real Provider, Gmail or
browser call, product-database manual SQL/mutation, fabricated candidate,
commit, push or deployment was performed.

## 53. Gate 9 Boundary and Ownership

Execution date: `2026-09-07`.

Task: `BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-9-001`.

Gate 9 used the bounded real-provider allowance only for the two authorized
sample generations, Awolvision and Manitosilk. It did not enter Gate 10, call
Gmail, fabricate candidates, manually mutate the product database, restart a
service, commit, push or deploy.

The owned implementation scope was limited to:

- canonical V2 feed-to-Opportunity selection and lifecycle facts;
- safe Opportunity projection of `projectContextVersion`;
- the existing labelled draft fallback when an AI adapter is unavailable;
- focused regression coverage for those paths;
- the stale Gate 7 migration-head assertion, without weakening its migration
  `0093` path, prerequisite or hash checks.

## 54. Gate 9 Implementation Corrections

Two production-path defects were reproduced and corrected:

1. V2 Opportunity creation had persisted the wrong UUID-shaped value as
   `projectContextVersion`. It now persists the integer
   `backlink_generation_input_pins.project_context_version` in the canonical
   selection snapshot and lifecycle facts. Projection accepts only an integer
   lifecycle value and otherwise falls back to the canonical selection
   snapshot, avoiding an unsafe UUID-to-integer cast.
2. A requested `MODEL` draft threw when no AI adapter was configured. It now
   completes through the existing labelled `TEMPLATE_FALLBACK` path with
   `BASIC_DRAFT_READY` and reason `MISCONFIGURED`. This path has zero AI cost,
   requires user confirmation and cannot auto-send.

The deployment manifest remains on legal head `0095`. Migration `0095`
reconciles durable contact facts and passed production-runner idempotency,
security-definer `search_path`, privilege, RLS and FORCE RLS checks. The Gate 7
contract continues to verify migration `0093`, while allowing subsequent
numeric manifest heads.

## 55. Gate 9 Two-Sample Acceptance

| Sample | Native V2 acceptance | Product-path outcome |
| --- | --- | --- |
| Awolvision | generation `9bd6f1a5-043c-403d-ad43-ea18af87518c`; 8 provider requests; 66 raw observations; 34 effective admitted candidates; first AVAILABLE batch size `7`; USD `0.0048` | `amazon.com` created Opportunity `3e08932c-065b-4a44-a204-a7ff82a10a11`; contact remained review-required; formal draft API returned HTTP `409` with zero downstream mutation |
| Manitosilk | generation `5afd8ef5-4ebf-4ad3-9a3b-2efa3b327815`; 4 provider requests; 37 raw observations; 15 effective admitted and released candidates; USD `0.0024` | `tarasartoria.com` created Opportunity `afea3a0e-1b88-45a1-823a-75be183b60a7`, job `88659924-78d8-47b0-bd55-31c70636d9fc` and labelled zero-cost basic draft `0a279424-3e49-4427-975d-f70a2ec96dac` |

Both accepted generations completed in Temporal, retained immutable input,
launch, request and path fingerprints, and used only
`BLUEPRINT_SERP_STANDARD_QUEUE` candidate source facts. Selected release items
have native generation-candidate IDs and `legacy_imported=false`. Historical
`legacyProjection` metadata was used only for negative domain suppression;
actual candidate lineage from V1 was zero.

Accepted generation usage was `12` DataForSEO calls and USD `0.0072`. Including
one superseded failed Awolvision attempt, the whole Gate 9 session used `13`
calls and USD `0.0078`, below the authorized USD `2` per-project and USD `4`
total ceilings. Post-generation AI calls, Gmail calls, send attempts and
additional provider usage were all zero.

## 56. Gate 9 Final Verification

All final code and test evidence was captured after the latest owned source
mtime.

| Check | Final result |
| --- | --- |
| Direct Opportunity and draft regressions | `2 files; 11 passed` |
| Gate 9 workflow/focused matrix | `6 files; 34 passed`, including `17` workflow-contract tests and two Temporal replay histories |
| Full deployment-manifest database matrix | `4 files; 20 passed` |
| Migration/source manifest checks | `87 files through 0095`; `28` source records; passed |
| Core build and owned-file ESLint | passed |
| Generated client / V2 contract | `93 operations`; passed |
| Focused frontend Vitest | `13 files; 46 passed` |
| Frontend product-path Playwright | desktop/mobile `4 passed` |
| Frontend typecheck / production build | passed |
| Scoped whitespace checks | passed |
| Accepted provider calls / cost | `12 / USD 0.0072` |
| Gmail / Gate 10 production call edge | `0 / 0` |

The broad outreach-source suite passed `42/43`; its sole failure is an
unrelated stale exact source-string assertion for the existing Mail Center
element. It does not cover the Gate 9 feed, Opportunity or draft paths and did
not trigger Gmail.

Product-state read-only verification proved the durable V1-write freeze,
`18/18` freeze triggers and zero active V1 project, generation, refill, job,
outbox, claim, provider-request, reservation and lease execution. Both sample
contracts are `V2_ACTIVE`.

The global phase-9 verifier truthfully remains incomplete because five other
projects are `MIGRATION_BLOCKED` and three later Awolvision canonical batches
remain `PREPARING`. This is a Gate 10/global cutover condition, not a Gate 9
two-sample acceptance failure. No global state was bypassed or changed.

Final evidence is retained under
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-9-FINAL-20260907T140000-CST`,
principally:

- `16-latest-source-static-database-verification.txt`;
- `17-ui-api-acceptance-and-screenshot-ledger.txt`;
- `18-final-two-sample-durable-acceptance-ledger.txt`.

## 57. Gate 9 Decision and Stop Point

Gate 9 is
`GATE_9_PASS_READY_FOR_SUPERVISOR_REVIEW`.

Execution stops at Gate 9. Gate 10 was not entered.

## 58. Gate 10 Execution Boundary

Gate 10 was entered on 2026-09-07 under the amended fix plan, including
physical V1 production retirement. The preceding Gate 9 stop statement is
historical. Reference task: `01a06512-b25a-73a0-a3d9-a2f0ba9ca036`.

This run preserves the existing dirty `main` worktree at HEAD
`7df8d48d088328bd79fb0a1afef364b17cc8b6af`. Only Gate 10 retirement,
native initialization and related verification hunks are owned by this run.
Checkpoint and deletion backups:
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-10-001`.

No new paid Provider operation, Gmail send, production data mutation,
Worker restart, commit, push or deployment was performed. Existing external
Provider blocks were not removed.

## 59. Gate 10 Implemented Production Changes

- Unregistered five V1 recommendation writes in Core and the Python gateway:
  reject, refill, cancel, close-duplicate and pool archive. Generated OpenAPI
  and frontend write methods were removed. Historical reads remain.
- Removed the V1 refill Workflow export/file, recovery bundle, production
  namespace, registered activities, relay/consumer construction, periodic
  refill and project-analysis refill hooks. Recovery mode fails explicitly
  with `BACKLINKS_V1_RECOMMENDATION_RECOVERY_RETIRED`.
- Removed the V1 provider execution and store branches, qualification/score
  wiring and publication writes from the shared DataForSEO runtime. Native
  V2 execution is required; a stale non-native caller fails before a database
  connection with `BACKLINKS_V1_RECOMMENDATION_PROVIDER_RETIRED`.
- Removed orphan-refill reconciliation and historical V1 reassessment
  executable scripts and package commands. Removed the unused V1 frontend
  workspace/hook; the production recommendation surface remains the V2 feed.
- Replaced project-analysis demand/refill initialization with tenant-scoped
  native `V2_READY` initialization for complete ACTIVE projects without
  generation history. Projection accepts new V2 qualification pins, does not
  overwrite blocked/history-bearing contracts, and does not create V1 demand.
- Added native first-generation staging from the authoritative snapshot and
  V2 input pin, without requiring a prior V1 generation. First staging and
  retry create one immutable generation/job, with zero Provider/refill writes.
  Canonical activation, not staging, owns the project contract transition.
- Updated the Temporal registry and validator for the scoped V2 workflow.
  Replaced the obsolete P0 source lock with an explicit 167-file SHA-256 V2
  source baseline, checking both membership and content.

Retained historical artifacts are not a second production implementation:
V1 orchestration/types and domain helpers still support historical tests,
old-ID reconstruction and audit compatibility; no retired Temporal wrapper
is exported by the production index. The old event name remains a historical
constant, not a relay registration. Immutable database facts and read paths,
including the 18 freeze triggers, were not removed or weakened. This is a
production-entrypoint retirement, not a claim that every V1 string/file was
deleted from the repository.

## 60. Gate 10 Verification

| Check | Result |
| --- | --- |
| Core unit/API/contract/security/resilience | `260 files; 1714 passed` |
| V2 database, feed, Opportunity, native initialization and shared outbox | `13 files; 70 passed` |
| Gateway and shared contracts | `47 passed` |
| Python project/projection/readiness/authority | `55 passed; 2 skipped` |
| Frontend focused Vitest | `12 files; 44 passed` |
| Frontend retirement source checks | `2 passed` |
| Desktop/mobile V2 Playwright | `4 passed`; screenshots inspected |
| Keyboard/accessibility Playwright | `1 passed` |
| Temporal replay | Both captured histories replayed in the Core suite |
| Core build / full ESLint | passed |
| Frontend typecheck / production build | passed |
| Migration/source manifests | `87 migrations through 0095`; `28 source records` |
| Core OpenAPI / generated client | `86 paths`; `88 operations` |
| Platform contract | `248 paths; 278 operations`; shared validation passed |
| Owned whitespace checks | passed |

The two Python database tests require
`BACKLINKS_PROJECT_PROJECTION_TEST_DATABASE_URL` and were skipped, not passed.
The native Core database path was exercised using disposable PostgreSQL.
The Playwright matrix uses mocked transport and proves UI behavior, not new
real-provider or final-running-build acceptance. Existing frontend build
chunk warnings remain. The full repository integration suite was not run;
the 13-file database matrix is the scoped result above.

Regression evidence includes a failing retirement baseline before removal,
all five old HTTP writes returning 404 without upstream calls, absence of
V1 registration even for an unfrozen V1 contract, native first-generation
idempotency, preservation of blocked projects on projection replay, and
rejection of incomplete native projects.

Final built artifact:

- build ID: `local-product-892b661e877a45900da29e6f`
- source SHA-256:
  `892b661e877a45900da29e6f50e3d031834c257dac04732cfcd6aff788cda1a8`
- artifact SHA-256:
  `235beceaca52613d5e7de7eb445b756e7f31e1f4e33c8258a0d365bfb71f5600`
- built at: `2026-09-07T10:53:57.061Z`

Primary logs: `core-regression-final.log`, `integration-final.log`,
`gateway-tests-final.log`, `project-python-final.log`, `core-build.log`,
`lint-final.log`, `frontend-e2e.log`, `frontend-keyboard.log`.

## 61. Gate 10 Live Read-Only Evidence and Blockers

The current phase-9 verifier returns `completed=false`:

- eligible projects `7`; V2_ACTIVE `2`; valid V2_ACTIVE `1`; invalid `1`;
- MIGRATION_BLOCKED `5`;
- active V1 project/generation/refill/job/outbox/claim/provider-request/
  reservation/lease counts all `0`;
- V1 writes frozen; freeze triggers `18/18`; historical V1 generations `13`.

All five blocked projects have reason
`V2_CANDIDATE_LINEAGE_INCOMPLETE` and zero current-generation V2 candidate
facts: `aiper.com`, `elephtv.com`, `everycine.com`,
`mpa-americalatina.org` and `snapmaker.com`. Their historical AVAILABLE
batches do not establish native V2 candidate authority and were not relabelled.

Awolvision has 37 candidate facts. Its first two canonical batches are
AVAILABLE; batches 3, 4 and 5 remain PREPARING with contact terminal counts
`0/7`, `0/7` and `0/6`. Their deadline is
`2026-09-08T01:56:15Z`, not yet elapsed at inspection. No terminal contact
fact or elapsed deadline was fabricated to force availability. Manitosilk has
16 candidate facts and its current batch is AVAILABLE with `15/15` contacts.
These current counts supersede earlier snapshots, without rewriting Gate 9
acceptance history.

The live Worker at port 7302 reports build
`local-product-ee61d9074a06638173744ff5`, not the final Gate 10 build.
It reports normal mode, PostgreSQL/Temporal ready, four waiting-provider jobs
and explicit external blocks for DataForSEO, browser, AI and Gmail. Health
readiness is not proof that the intended final build is polling.

Evidence: `phase9-verify-final.json`, `project-state-final.json`,
`candidate-facts-final.json`, `batches-final.json`, `worker-health-final.json`.
No new Provider call was initiated by this run. Final-build runtime
write/cost observation and fresh two-sample acceptance have not been performed.
Gate 9 real-provider results remain separately labelled historical evidence.

## 62. Gate 10 Decision and Remaining Work

**BLOCKED. NOT DEPLOYED. Do not report V2_ONLY_READY.**

Implementation and scoped tests passed, but all-project native lineage,
complete contact preparation, intended-build polling and final-build real
acceptance invariants remain unmet.

Remaining work must use the shared V2 product paths: generate valid native
candidate authority for the five blocked projects under explicitly approved
Provider limits; complete Awolvision contact preparation using real terminal
facts or the existing deadline policy; switch and verify the intended local
Worker/API build under controlled Provider settings; then repeat global
verification, sample UI/API acceptance and write/cost-delta observation.
Do not substitute SQL state changes, historical candidate relabelling or
test fixtures for those product results.

## 63. Gate 10 Stop Diagnosis and Recovery Fix

Continuation on 2026-09-07 distinguishes three unrelated events:

- The previous Gate 10 turn deliberately concluded BLOCKED. It was not an
  automatic tool interruption; local implementation and runtime verification
  could and should have continued.
- The Gate 9 final restart helper explicitly sets all four provider availability
  values to unavailable with reason `explicit_block`. This is a local operator
  configuration, not evidence of a provider ban.
- An earlier referenced task turn failed with upstream HTTP 503. That model
  transport failure is separate from the local provider configuration.

Starting the previously built Gate 10 runtime exposed a shared recovery defect:
contact preparation selected compatibility generations with V1 input pins and
no native candidate authority, repeatedly violating
`backlink_release_item_native_generation_candidate_ck` for elephtv.
The repository and controlled recovery-scope function now require native V2
pins and contract versions and exclude legacy-imported/unlinked batch items.
Legacy inventory recovery no longer selects V2-contract projects.

A second defect fixed the recovery window permanently at batches 1 and 2.
Recovery now uses the highest published cursor ordinal for the scoped generation
and prepares that canonical batch plus one ahead, matching architecture section
7.7. The regression advanced a real fixture cursor to ordinal 2: before the fix,
recovery incorrectly returned idle; after the fix, it recovered batches 2 and 3.
The PostgreSQL test also invokes controlled scope enumeration without tenant
settings under a non-bypass role.

Forward migration `0096_backlink_recommendation_pool_v2_rolling_recovery.sql`
updates the controlled function and adds SELECT-only owner policies for input
pins and user cursors. FORCE RLS remains enabled. Its manifest entry is step 287,
requires 0095, and has SHA-256:
`315f15fc179cf586874c7649c2f331796f1e3b01cdb62f7b56aef90a5b795b56`.
The official manifest planner/runner applied it to the local database; no
historical business rows were rewritten.

Correction to sections 61-62: both Awolvision users are currently at batch 1,
and batches 1 and 2 are AVAILABLE. Hidden batches 3-5 remaining PREPARING are
consistent with rolling preparation, not themselves evidence of a stalled
product. The existing phase-9 verifier requires every batch to be AVAILABLE;
its invalid-project count is recorded unchanged, not treated as proof of this
specific product defect. This continuation did not weaken that verifier or
declare Gate 10 complete.

## 64. Continuation Verification and Remaining Boundary

Current-continuation verification:

| Check | Result |
| --- | --- |
| Core unit/API/contract/security/resilience, including two Temporal replays | 260 files; 1714 passed |
| Scoped V2/feed/Opportunity/projection/outbox PostgreSQL matrix | 13 files; 70 passed |
| Dedicated canonical batch regression | 6 passed |
| Python shared contracts | 7 passed |
| Core build, build identity, focused ESLint, owned whitespace | passed |
| Migration and source manifests | 88 migrations through 0096; 28 source records |

The initial Core run had one timeout under concurrent load; the complete retry
with two workers passed. The first database matrix found an outdated 0095
head assertion; after updating it to 0096, the entire matrix passed. Frontend
and wider Python results in section 60 are historical, not rerun claims here.

At 2026-09-07 19:46:34 CST, the local API and Worker restarted onto:

- Build: `local-product-fd7381d7621071f042423a6c`.
- Source SHA-256: `fd7381d7621071f042423a6cf875223a1d55dc77ef243e8ecbaadb5c1221da73`.
- Artifact SHA-256: `81c73a779d5410a73e8f84afa7e0ef53b80b64a9cd7d163c7ca98dc9b1251e2d`.
- API PID 22232; Worker PID 37336; both health endpoints report this build.

The final read-only observation confirms fresh workflow and activity pollers
for PID 37336 on this build, normal business consumers, and ready PostgreSQL
and Temporal. The older PID 25972 is absent; its older poller entry remains
temporarily cached and is not current-process evidence. The new Worker logs
contain no recurrence of the historical batch-item constraint error.

Provider request and ledger counts remain 214 and 237; new requests since
2026-09-07T11:18:36Z are zero. All active V1 counters remain zero and freeze
triggers remain 18/18. Migration 0096 is installed. All seven production
recovery reads return idle, consistent with the current eligible batch windows.
Four provider blocks and four pre-existing waiting-provider jobs remain.

Gate 10 is still NOT V2_ONLY_READY and NOT DEPLOYED: five projects remain
MIGRATION_BLOCKED with `V2_CANDIDATE_LINEAGE_INCOMPLETE`. Their native generation
must run through the shared product path under an explicitly authorized
provider budget; fresh final-build real-provider/sample acceptance remains
outstanding. No unrestricted provider resume, Gmail send, Git publication or
deployment was performed. Local repair and intended-build polling are now
verified rather than left as blockers.

Evidence under the Gate 10 checkpoint:
`continuation-stop-diagnosis.md`, `continuation-core-regression-retry.log`,
`continuation-integration-retry.log`, `continuation-migration-runtime.jsonl`,
`continuation-restart.json`, and `continuation-runtime-final.jsonl`.

## 65. Bounded Native Discovery Continuation

The user explicitly requested continued Gate 10 execution rather than another
premature stop. The bounded start card records five existing blocked projects,
native seed confirmation and launch APIs, and DataForSEO-only availability.
AI, browser-provider and Gmail remained explicitly blocked. No Gmail send,
deployment or Git publication was performed.

All five projects completed native discovery. The following counts are native
discovery terminal facts BEFORE canonical historical-domain admission, not
released item counts:

| Project | Native effective candidates | Requests | Settled USD micros |
| --- | ---: | ---: | ---: |
| Aiper | 26 | 4 | 2400 |
| Snapmaker | 32 | 4 | 2400 |
| Elephtv | 54 | 8 | 4800 |
| Everycine | 27 | 4 | 2400 |
| Mpa America Latina | 54 | 8 | 4800 |

At 2026-09-07 21:38 CST all 28 requests had succeeded. Total actual settled
cost was 16800 USD micros ($0.0168). Contact preparation remains a separate
rolling, durable queue; successful discovery alone is not V2_ONLY_READY.

Three shared defects were reproduced and repaired:

1. Native discovery could finish while the canonical job still displayed
   waiting-provider. Scoped repository finalization/recovery now marks the
   matching native job running/canonical_batch_preparation at progress 50.
   The PostgreSQL regression failed before this change and passed afterward.
2. Everycine's immutable project locale pt-BR produced an intent language pt-BR
   while the provider adapter used pt. The executor now uses the existing
   provider locale resolver. A subsequent native DB guard also required the
   full project locale; forward migration 0097 normalizes that comparison to
   the same provider language without changing project facts. Wrong-language
   requests remain rejected. The original failed attempt is retained, and the
   staged retry generation was relaunched through its existing confirmation
   and idempotency key after applying the migration.
3. The cutover verifier incorrectly required hidden future batches to be
   AVAILABLE. Forward migration 0098 permits unpublished PREPARING batches,
   while requiring batch 1 and every published batch to be AVAILABLE and
   contact-terminal, with exact native lineage and item counts throughout.
   A real cursor-2 PostgreSQL regression failed before the migration and
   passed afterward; activating a still-PREPARING first batch is still invalid.

Migration 0097 is manifest step 288, requires 0096, SHA-256
`1c3ae203af17fe4fdd10719ee6d091777133e2c80991efc30dd4fd0e0f4670c0`.
Migration 0098 is step 289, requires 0097, SHA-256
`0d03afc1b108045f9b3c90f2e82a7cfcb0f19e40e1ce9d4dc78395b563258653`.
Both were applied through the official deployment-manifest planner locally.
No manual business-row updates or fabricated contact outcomes were used.

Fresh verification: 260 Core files / 1717 tests passed; six scoped PostgreSQL
files / 45 tests passed; full Core lint and build passed; source manifest
28 records and migration manifest 90 files through 0098 passed.
The final Core artifact hash is
`daff50fb30078f596cd00bfd3444150d06bc012c44e27c7a08edb8d0c0aeb6f4`,
identical to the artifact that executed the successful bounded discovery.
The updated source/manifest build identity is
`local-product-a6449d51a40a39719b45c5e3`.

At this checkpoint global cutover is still pending contacts: eligible 7,
valid V2_ACTIVE 2, invalid V2_ACTIVE 0, MIGRATION_BLOCKED 5. All active V1
counters remain zero and freeze triggers remain 18/18. This is a progress
snapshot, not a final Gate 10 decision. Sections 62 and 64 describe earlier
stops and must not be mistaken for the current execution boundary.

## 66. Final-Build Regression and Sample Revalidation In Progress

At 2026-09-07 22:16 CST, Mpa and Everycine have activated through the native
product workflow. Global verification now reports 4 valid V2_ACTIVE projects,
3 MIGRATION_BLOCKED projects, zero invalid active projects, all active V1
counters zero, and all 18 freeze triggers installed. Snapmaker, Elephtv and
Aiper continue real contact preparation under the unchanged retry/deadline
policy. This is continued execution, not another stop decision.

Fresh final-source verification:

| Check | Result |
| --- | --- |
| Full Core PostgreSQL integration suite | 75 files passed, 4 skipped; 356 tests passed, 14 skipped |
| Full frontend Vitest | 93 files; 596 tests passed |
| Final desktop/mobile/keyboard Playwright matrix | 30 passed |
| Frontend production build after mobile fix | passed; pre-existing chunk warnings |
| Focused Core/frontend ESLint and owned whitespace | passed |
| Core build identity check | passed; unchanged a6449d51 source and daff50fb artifact |

The only initial full-integration failure was the 100-connection Opportunity
counter test timing out while opening localhost connections. PostgreSQL
observations showed 79 idle sessions, below max_connections=100, before any
of the business transactions ran. Serializing handshakes did not resolve it.
Using an explicit IPv4 loopback for this test's local harness did; the final
test retains all 100 simultaneous connection handshakes and all 100 concurrent
business transactions. The complete integration suite then passed. External
database hostnames remain unchanged.

Accessibility checks initially raced finite UI entry animations. The tests
now wait for those animations to finish before running Axe, without disabling
contrast rules. A separate live 390px Manitosilk check reproduced a 402px
document width from unbroken native/historical reason codes. The shared feed
reason list now wraps those codes anywhere. The regression failed before the
fix and passed afterward on desktop and mobile. Live Awolvision and Manitosilk
both report document width 390 at viewport width 390.

The final local API/Worker build is local-product-a6449d51a40a39719b45c5e3;
the intended PID 51724 is the fresh workflow and activity poller. All four
external provider availabilities are again explicit_block after the completed
bounded discovery; normal business consumers and static contact work remain
running. Requests/ledger remain 242/265, with exactly the 28 authorized new
discovery requests.

Original real-provider samples were revalidated against this running build:

- Awolvision feed returns 17 historical/native entitled items; latest native
  generation remains SUCCESS, 34 admitted and 7 initially released.
- Manitosilk feed returns 16 historical/native entitled items; latest native
  generation remains SUCCESS, 15 admitted and 15 initially released.
- Both formal Get More requests return NOT_UNLOCKED; replaying the same keys
  returns replayed=true with unchanged cursor and no new provider calls.
- Both formal Opportunity commands use recommendationFeedItemId and return
  existingOpportunity=true with the original canonical Opportunity identities.
- The no-email Awolvision formal Draft request returns 409 BACKLINK_CONFLICT.
  Its email draft, request snapshot and draft version counts remain zero.
- Desktop/mobile live screenshots were captured and inspected. The unrelated
  project-agent conversation endpoint still returns 404 in the sidebar; this
  is recorded rather than claiming a console-error-free whole application.

These are fresh final-build sample reads/commands over real-provider lineage,
not a claim that Awolvision/Manitosilk discovery was rerun on this build.
The five-project bounded discovery in section 65 used the final artifact.
No real Gmail send, deployment or Git publication was performed. Real Reply,
Placement and Reports provider acceptance is not inferred from mocked E2E.

Evidence includes continue-full-integration-final.log,
continue-e2e-final-wrap.log, continue-mobile-overflow-red.log,
continue-mobile-overflow-green.log, continue-no-email-final.log,
continue-native-opportunity-final.log and continue-runtime-2217.jsonl in
the Gate 10 checkpoint; screenshots are under output/playwright/gate10-*.

## 67. Additional Regression Coverage and Continued Contact Processing

The 14 database tests skipped by the default full Core integration command
were explicitly rerun with BACKLINKS_TEST_DATABASE_URL pointing to a disposable
Testcontainers instance. All 7 selected files / 19 tests passed, including the
14 formerly skipped tests and 5 overlapping tests. Combined coverage is 370
distinct integration tests; this is not represented as a single 370-test run.
Evidence: continue-optional-db.log and continue-optional-db.mts.

The frozen Python source baseline now contains 170 files, adding migrations
0097/0098 and refreshing only the repository, executor and shared feed hashes
changed by this continuation. Strict membership and content guards remain
enabled. The shared contract suite passed 7 tests after reproducing the
missing-migration baseline failure.

The expanded Python gateway/project matrix passed 102 tests with 2 database
projection tests skipped for an absent dedicated database URL. Its initial
history-order failure was a nondeterministic fixture: two created_at values
could share a clock tick and fall back to random run IDs. The fixture now
sets the two creation timestamps explicitly. Production SQL ordering and
attempt-number semantics are unchanged.

At 2026-09-07 22:34 CST, 5 of 7 projects are valid V2_ACTIVE, with zero
invalid active projects and 2 still preparing. Aiper has one remaining
contact job in its third/final attempt; Elephtv has started contact processing.
All V1 active counters remain zero, freeze triggers remain 18/18, and provider
requests/ledger remain 242/265. Processing continues with unchanged contact
concurrency, retry and preparation deadlines. No final decision is issued
at this intermediate checkpoint.

At 22:39 CST, the two skipped Python database projection tests were covered
by a supplementary 10-test run, all passing, on a disposable PostgreSQL
container. Initialization used the repository's schema/role bootstrap
0001_growthos_schema_roles.sql followed by the full official Alembic upgrade
through 20260825_0066. The first container attempt omitted the role bootstrap
and correctly failed; the test helper now follows the required ordering.
No product database was used for these tests. Combined Python matrix coverage
is 104 distinct tests. Evidence: continue-python-projection-bootstrap.log.

At 22:41 CST, live browser-to-gateway reads returned HTTP 200 and
backlinks.recommendation-feed.v2 for Aiper, Snapmaker, Everycine and Mpa.
Elephtv still returned HTTP 409 while preparing, without V1 fallback.
Gate 10 retirement and Temporal replay tests were rerun: 2 files / 4 tests
passed, including replay of both captured histories. The mobile Manitosilk
draft screenshot was inspected: the existing basic-template draft explicitly
shows AI did not participate and requires human editing.

## 68. Current Member Initial Publication Closure

At 2026-09-07 23:06:59 CST, the canonical verifier first reported all 7
eligible projects valid V2_ACTIVE, zero MIGRATION_BLOCKED projects and
completed=true. All scoped contact recovery reads subsequently returned idle.
The normal retry, contact concurrency and preparation deadlines were retained.

Final human-session UI verification then found a separate real defect:
Elephtv generation 14 had completed with an AVAILABLE first batch, but the
current member still saw only 15 items through generation 13. The acceptance
launcher had signed its request using the project snapshot's created_by,
which for Elephtv was website-project-service. The backend correctly scoped
the initial publication to that actor. Those earlier launcher results prove
discovery and batching, not the human member's publication.

The existing generated publish-initial API is idempotent and scoped to the
authenticated actor, but the shared frontend did not invoke it when another
authorized member first opened an available generation. The product fix:

- add a generated-client wrapper for backlinksPublishInitialRecommendationBatchV2;
- when the current member is NOT_PUBLISHED and the latest release is
  AVAILABLE/RELEASED, publish its initial batch through that existing endpoint;
- refresh both feed and release status after successful publication;
- abort on project exit and ignore late results, retaining existing error and
  refresh behavior without launching discovery or advancing Get More.

The browser regression failed before the fix because the new native item
never became visible. It now passes on desktop and mobile, alongside a
not-ready case that performs no publication. Unit coverage verifies the
generated request, both projection refreshes and aborted/late completion.
No actor authorization, entitlement SQL, provider settings or history rows
were rewritten. The one-off paid discovery launcher was not rerun.

The real Elephtv page automatically published generation 14 for the human
member through the normal UI. Its total became 25, with generation 14 visible
and cursor 1. Real navigation through all seven project pages then verified:

| Project | Latest native generation | Human feed total | Human publication |
| --- | --- | --- | --- |
| Aiper | 3 | 15 | PUBLISHED, cursor 1 |
| Snapmaker | 5 | 20 | PUBLISHED, cursor 1 |
| Elephtv | 14 | 25 | PUBLISHED, cursor 1 |
| Everycine | 6 | 26 | PUBLISHED, cursor 1 |
| Mpa | 3 | 10 | PUBLISHED, cursor 1 |
| Awolvision | 8 | 17 | PUBLISHED, cursor 1 |
| Manitosilk | 4 | 16 | PUBLISHED, cursor 1 |

Every response was HTTP 200 with backlinks.recommendation-feed.v2 and the
matching project scope; every latest generation was SUCCESS and matched
the newest generation in that member's released pool. Totals include retained
historical entitlements where present, not just newly discovered candidates.
Elephtv viewport screenshots were inspected at 390x844 and 1440x1000;
document widths were respectively 390 and 1440, with no page overflow.
The unrelated agent sidebar 404 remains visible and is not concealed.

Final frontend verification after this fix: 93 files / 599 unit tests passed;
34 desktop/mobile/keyboard E2E tests passed; production build and focused
ESLint passed. The build retains existing large-chunk/dynamic-import warnings.
Strict frozen source membership remains 170 files; only the four changed
frontend API/workspace source and unit-test hashes were refreshed, and the
shared Python contract suite again passed all 7 tests.

Evidence in the Gate 10 checkpoint:
continue-initial-publication-red.log, continue-initial-unit.log,
continue-initial-e2e.log, continue-initial-live-ele.log,
continue-seven-human-feeds-final.log, continue-seven-human-feed-results.log,
continue-frontend-initial-final.log, continue-frontend-build-initial-final.log,
continue-e2e-initial-final.log and continue-shared-initial-final.log.
Screenshots: output/playwright/gate10-elephtv-*-v2-only.png and
output/playwright/gate10-elephtv-*-viewport-final.png.

## 69. Gate 10 Final Decision

**V2_ONLY_READY for the final local product build; NOT DEPLOYED.**

Scope clarification (2026-09-08): this is the V2-only cutover decision, not
a full Gate 7 performance PASS. The Gate 7 evidence decision in section 70
remains independent; missing historical observations cannot be inferred
from a successful cutover.

This decision supersedes the intermediate BLOCKED snapshots in sections
62/64 and the checkpoint ownership ledger. Earlier execution stopped by
issuing its own BLOCKED decision while product work remained; it was not
an automatic Codex permission denial. The local explicit_block flags are
provider ceilings, not a provider ban or a reason to abandon local work.

At 2026-09-07 23:29 CST, final runtime verification reported:

- eligible/valid V2_ACTIVE projects: 7/7; invalid active projects: 0;
- MIGRATION_BLOCKED projects: 0; canonical completed=true;
- active V1 generation, project, refill, refill job, outbox, claim,
  reservation, lease and provider-request counters: all 0;
- all 18 expected V1 write-freeze triggers installed; 13 historical V1
  generations retained as immutable evidence;
- all seven project recovery states idle and recoveryScopes=[];
- provider requests/ledger unchanged at 242/265, exactly 28 authorized
  discovery requests since the bounded run began;
- final API and Worker healthy, normal business consumers running, and only
  intended Worker PID 51724 polling workflow and activity task queues.

Four pre-existing AI WAITING_PROVIDER jobs remain outside this recommendation
cutover; staleRunningJobs=0. Paid DataForSEO, browser, AI and Gmail availability
is explicitly blocked again after the bounded discovery was settled.
The local runtime therefore does not authorize new paid generation or mail.

Final Core identity was rechecked after the frontend fix:

- buildId: local-product-a6449d51a40a39719b45c5e3
- source: a6449d51a40a39719b45c5e301a31a452573ee15d5de4cc176c11a1be13edb97
- artifact: daff50fb30078f596cd00bfd3444150d06bc012c44e27c7a08edb8d0c0aeb6f4

Final static/contract checks passed: 90 migration files through 0098,
86 OpenAPI paths, 88 generated-client operations, 28 source-manifest records,
Gate 10 production retirement checks and both captured Temporal history
replays. Forward migration checksums and prerequisites remain those recorded
in section 65; no business-state SQL repair was used.

Evidence layers are deliberately separate:

| Layer | Result |
| --- | --- |
| IMPLEMENTED | V2-only production recommendation paths; V1 execution retired; native lineage and current-member UI closure complete |
| TESTED | Core 1717; Core DB 370 distinct across default/supplemental runs; Python matrix 104 distinct; final frontend 599; E2E 34; static/contract checks passed |
| LOCAL_RUNTIME | Final API/Worker identity, all 7 projects, human feed scopes, zero active V1 and no unexpected provider calls verified |
| REAL_PROVIDER | Two retained real-provider samples revalidated; five authorized native discovery runs on final Core artifact, 28 settled calls totaling USD 0.0168 |
| SAMPLE_ACCEPTANCE | Awolvision/Manitosilk canonical lineage, feed, Get More replay, Opportunity identity and no-email downstream gate evidence recorded in section 66 |
| DEPLOYMENT | NOT DEPLOYED; no commit, push or remote deployment |
| HUMAN_UAT | Not performed; automated live browser checks do not imply human sign-off |

Mocked Send/Reply/Placement/Reports E2E is not represented as real Gmail or
external fulfillment acceptance. Existing basic-template draft evidence is
not represented as AI-generated draft acceptance. The unrelated sidebar
error and build warnings remain disclosed rather than being folded into a
claim that the entire application has no defects.

Final runtime/static evidence: continue-runtime-v2-only-final.jsonl,
continue-identity-v2-only-final.log, continue-migration-v2-only-final.log,
continue-retirement-v2-only-final.log, continue-openapi-v2-only-final.log,
continue-client-v2-only-final.log and continue-source-v2-only-final.log.
The local UI remains available at http://localhost:5173.

## 70. Gate 7 Closure Attempt: Instrumentation and Polling

2026-09-08, scope BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-7-CLOSURE-001.
**IMPLEMENTED / TESTED / LOCAL_RUNTIME verified for the changes below;
full Gate 7 remains REAL_BASELINE_COVERAGE_INCOMPLETE, not PASS.**

The retained samples establish a real latency problem, but neither has
historical browser first-observation timestamps or end-to-end launch HTTP
acknowledgement timing. Awolvision also crosses a recovery boundary whose
September 4 Temporal history is no longer returned by the current listing.
These gaps remain explicit; no timing events were backdated.

Product changes:

- Added authenticated, project-scoped POST recommendation-feed/observations.
  The repository resolves the native job and generation lineage server-side;
  the caller cannot supply job authority. Tenant, project and generation
  constraints apply before any write. GET feed remains read-only.
- Frontend records the first visible render of each generation/state tuple,
  not every progress-count poll. Hidden documents wait until visible;
  project/state changes abort stale requests. Telemetry failure is
  nonblocking, with at most three attempts per effect.
- Database uniqueness preserves the first actor/generation/state event.
  Server receipt time is authoritative. Client observed time is retained
  only as UNTRUSTED_CLIENT evidence and cannot overwrite occurred_at.
- Launch scheduling now records service-entry, confirmation and Temporal
  start durations. Its boundary is LAUNCH_SERVICE_ENTRY_TO_TEMPORAL_ACK,
  not the full browser-to-HTTP-response ACK. That distinction is required
  when the next real sample is measured.
- New workflow executions use versioned publication polling at 5 seconds,
  bounded by the remaining preparation deadline. Existing histories retain
  operations.v1's 15-minute wait through a Temporal patched boundary.
  Provider budgets, contact attempt limits and deadlines are unchanged.
  This removes an avoidable polling interval; it does not make contact
  preparation finish in five seconds or guarantee healthy-worker latency.

Before the Core restart, there were no active native-generation or contact
jobs. Three captured real native workflow histories replay against the new
source (108, 43 and 65 events). Unit cases separately verify old 900000 ms,
new 5000 ms and shorter 1200 ms deadline behavior. Build ID alone is not
being treated as Temporal version protection.

## 71. Gate 7 Real Timing Summary

All milestone timestamps below are UTC on 2026-09-07. The first two rows
refer to the original scheduling pair, not a fabricated continuous Awol
recovery interval. Provider sums are activity envelopes across requests and
may overlap; they are not elapsed wall time or pure provider CPU time.

| Measurement | Awolvision, generation 9bd6f1a5 | Manitosilk, generation 5afd8ef5 |
| --- | --- | --- |
| Historical durable timing events | 328 | 181 |
| Scheduled to workflow started | 106 ms | 132 ms |
| Workflow started to seed loaded | 17 ms | 42 ms |
| Discovery terminal boundary, from batch preparation start | 01:56:15 | 04:40:02 |
| Candidate admission completed | 01:56:14.784923 | 04:40:02.232383 |
| First batch PREPARING timing event | 01:56:15.199837 | 04:40:02.688522 |
| First batch AVAILABLE in database | 04:28:36.056890 | 05:09:50.582526 |
| Publication committed | 04:36:09.045445 | 05:10:03.443653 |
| Contact preparation envelope | 6301.557 s | 1800.553 s |
| All requested prepared batches AVAILABLE to publication | 246.086 s | 12.861 s |
| Provider request start/end pairs | 8 | 4 |
| Sum of provider request envelopes | 66.700 s | 109.015 s |
| Maximum provider outcome persistence interval | 541 ms | 1449 ms |
| Contact jobs / recorded attempts / captured workflow runs | 14 / 22 / 22 | 15 / 28 / 28 |
| Maximum captured contact activity queue | 33.304 ms | 32.426 ms |
| Historical launch HTTP ACK | MISSING | MISSING |
| Historical first browser-visible AVAILABLE | MISSING | MISSING |

Four user-facing latency measures remain separate: discovery terminal,
candidate pool persisted, batch PREPARING, and first visible AVAILABLE.
The database milestones above do not substitute for the fourth measure.
Awolvision recovery is not treated as a continuous valid baseline.

The 15-minute polling timers overlap actual contact processing. Counting
their full duration as removable product delay would be incorrect.
The 246.086 s and 12.861 s tails are measured after all requested batches
were ready. The new versioned 5 s polling policy addresses that known
controllable delay. Contact activity envelopes still include website I/O,
local processing and persistence; their internal subdivisions are not
proven pure external-provider time. Every second is therefore not yet
fully classified at the required granularity.

Read-only capture, per-attempt queue/execution/timer breakdowns, missing
evidence labels, and reproducible analysis are retained in:
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-7-CLOSURE-001/`
as capture.mjs, analyze.mjs, timing-summary.json, per-generation snapshots,
per-generation timing-report.json, generation/contact history files,
replay.mjs and replay-results.json.

## 72. Gate 7 Local Verification and Remaining Exit Criteria

On 2026-09-08 the real UI recorded terminal observations for Awolvision at
01:32:42.937901 UTC and Manitosilk at 01:33:22.718593 UTC (server receipt).
Both returned 200. Repeated page loads preserved exactly one event per
actor/generation/state. Submitting Awolvision's generation under the
Manitosilk project returned 400 BACKLINK_INVALID_REQUEST with no extra
event. These are post-instrumentation terminal-page checks, not September
7 first-availability evidence.

The desktop and 390px mobile screenshots show the current project's feed
without overlap or horizontal overflow. The pre-existing agent sidebar
conversation 404 remains unrelated. Intermediate observation 404s occurred
before the gateway reload; final observation requests succeed.

| Verification | Result |
| --- | --- |
| Core unit + API + contract | 249 files, 1602 tests passed |
| Final timing/polling tests after lint cleanup | 2 files, 8 tests passed |
| Frontend full unit suite | 94 files, 602 tests passed |
| Recommendation Gate 6/7 desktop + mobile E2E | 8 passed |
| Python gateway + shared/frozen contracts | 47 passed |
| Captured real native Temporal replay | 3/3 passed |
| Core typecheck, build, full lint, build identity | passed |
| Frontend build, changed-file lint, generated client | passed; 89 operations |
| Migration check / source manifest / OpenAPI | 90 files through 0098 / 28 records / 87 paths |

Regression failures were classified and corrected, not ignored: exact
route/operation counts and semantic/source hashes changed with the new
telemetry route; E2E fixtures now explicitly handle observation POSTs while
still rejecting unexpected business/provider mutations. Two test mock
signatures were cleaned up for unused-argument lint. Frozen path membership
checks remain strict, including the two new frontend observation files.
The full Core database integration suite was not rerun in this scope;
actual repository persistence, duplicate and cross-project behavior were
checked through the local authenticated API and read-only database queries.

Final local Core identity:

- buildId: local-product-c40826cd3fb9afabba6be1cd
- source: c40826cd3fb9afabba6be1cd334bef138e403a2826e7438e4466fe07f00d5ec0
- artifact: a27c2ea7f0c623fc08db5b6b2d09d17c615ca20885fdf18a95f81f2e639c7be7

Gateway/API/Worker are healthy. Provider ceilings remain explicit_block.
The prior 242 counter is provider_batch_requests, not all
backlink_provider_requests (280). Provider usage ledger remains 265;
no additional paid batch request or Gmail send was performed. Runtime
evidence is retained in runtime-evidence.json in the Gate 7 checkpoint.
No commit, push, deployment or human UAT was performed.

Remaining exit criteria, not waived by these tests:

1. Obtain two bounded real runs under explicit provider authorization with
   browser request/response capture from launch through terminal publication.
   Existing paid-run authorization is not reused for additional calls.
2. Validate browser HTTP ACK <=2 s and scheduled-to-start <=10 s; capture
   every observed state from run start and preserve server/client clock
   boundaries. Service-to-Temporal duration alone is not HTTP ACK.
3. Classify contact I/O, local persistence, retries and polling separately.
   No unexplained interval >10 s may be relabeled as provider time.
4. Measure the 5-second policy on fresh runs, compare ready-to-publication
   tails and check increased polling load. Set final end-to-end targets only
   after both baselines meet coverage requirements.

This is a completed local remediation and evidence pass, not completion of
the full Gate 7 exit gate. Further paid sample execution requires a bounded
authorization; no historical timing or candidates will be manufactured to
turn the decision green.

## 73. Gate 7 Bounded Real Closure on 2026-09-08

Decision: **Gate 7 PASS for the measured local real-sample exit gate**.
This supersedes the outstanding Gate 7 sample criteria in section 72,
not the independent product-quality, deployment or human-UAT gates.

### Authorization and Spending

The user explicitly approved raising this execution's cumulative ceiling
to USD 0.10 and then requested completion with minimal additional spend.
The fixed accounting window starts at 2026-09-08T02:00:00Z. This is not
USD 0.10 on top of the previous authorization.

The shared DataForSEO reservation repository now takes an optional execution
ceiling. It validates the paired start/limit configuration, serializes
reservations using a tenant/provider advisory transaction lock, counts
settled actual charges plus outstanding estimates, and fails closed before
calling the existing reservation function. Existing generation-level USD 2
authorizations cannot override this execution ceiling. All projects in this
workspace share the USD 0.10 ceiling.

Exactly two generations were launched through the authenticated browser
seed-confirmation and Generate workflow. Eight actual SERP task submissions
settled at 600 micros each: **4800 micros / USD 0.0048 total**. No outstanding
reservation remains. No additional acceptance generation was launched.
The 25000-micro per-call estimate explains why the earlier 16800-micro
ceiling could not authorize even one new reservation despite lower actual
charges. Raising the ceiling did not mean spending it.

### Real Timing Baselines

All timestamps below are from September 8, 2026. End-to-end values begin at
browser launch-request entry, not seed staging/confirmation. Client clocks
are explicitly untrusted observations; server receipt is retained as well.

| Measurement | Manitosilk generation 5 | Awolvision generation 9 |
| --- | --- | --- |
| Generation contract | 70380585-08f3-4dae-964a-3825339146fc | 7ddcd18e-d1b5-4045-aadb-1bb334fc1ad3 |
| Browser launch UTC | 02:25:43.965 | 02:29:07.488 |
| HTTP launch ACK | 141.7 ms | 82.5 ms |
| Scheduled to workflow started | 130 ms | 109 ms |
| Discovery terminal | 32.035 s | 59.512 s |
| Candidate pool persisted | 32.094 s | 59.695 s |
| Batch PREPARING | 32.360 s | 59.992 s |
| First batch AVAILABLE in database | 176.842 s | 293.253 s |
| First rendered AVAILABLE | 177.902 s | 295.355 s |
| Last terminal contact to publication | 2.594 s | 0.561 s |
| All prepared batches AVAILABLE to publication | 0.109 s | 0.119 s |
| Publication to first rendered AVAILABLE | 0.951 s | 1.983 s |
| New candidates admitted / published | 3 / 3 | 3 / 3 |
| Contact jobs / attempts / captured runs | 3 / 4 / 4 | 3 / 4 / 4 |
| Provider calls / actual USD | 4 / 0.0024 | 4 / 0.0024 |
| Final durable result | SUCCESS, PARTIAL_EXHAUSTED, AVAILABLE | SUCCESS, PARTIAL_EXHAUSTED, AVAILABLE |

Discovery timestamps returned by finalization are truncated to seconds;
their precision is less than one second, not millisecond accuracy.
The six newly released rows are real persisted candidates, not fixtures.
Prior released pools remain visible; new supply is not confused with all
historical rows or with the full number of raw SERP domains.

### Named Waits and Remaining Performance Boundary

Contact activity results now durably include monotonic internal spans for
job claim, public HTTP, robots evaluation, optional browser authorization/
render, contact parsing plus persistence, page persistence and completion
persistence. All eight real attempts have these results in Temporal history.
Contact retries preserve the existing 30-second policy and three-attempt
maximum. No robots, login, CAPTCHA or access-denied rule was bypassed.

The two DataForSEO standard-queue adapter envelopes total 30.295 s and
58.132 s respectively. Maximum result-persistence intervals are 356 ms and
267 ms. These are explicitly **adapter envelopes**, including submit,
task-ready HTTP polling, configured 500 ms sleeps and result retrieval;
they are not provider-internal compute measurements. The count/duration
of individual provider poll sleeps was not persisted separately. Public
website I/O, contact persistence, contact retry waits, relay/capacity queues,
Temporal activity queues and publication timers are separately named.
Concurrent attempt totals overlap and must not be summed as wall time.

The largest remaining product-controlled wait is contact capacity:
the third contact waited 67.927 s and 54.840 s. Shared production runtime
limits contact execution to two concurrent jobs
(`production-runtime.ts`, `maxConcurrentContactEnrichmentJobs` and
`availableContactSlots`). The captured first two attempts occupy the slots
during those waits. Retry eligibility adds 30 s, followed by 4.281 s and
3.535 s of relay/close overhead. These waits are explained, not hidden as
provider time.

Increasing the shared contact limit remains **BLOCKED on safe capacity
validation**, not on buying more SERP results: two three-contact samples do
not validate multi-project fairness, memory/CPU pressure or per-domain
politeness at higher concurrency. Keep this limit until a controlled local
load test with per-domain bounds establishes the next value. The gate
explicitly permits the largest controlled span to be documented as blocked;
this is not a claim that contact throughput is optimized.

The old 900-second publication polling branch is safely preserved for old
histories; fresh runs exercise the patched 5-second branch. Their 28 and 46
inspection activities used 2.457 s and 1.990 s of total activity time
(maximum individual inspection 1.208 s and 0.113 s). The post-contact tails
above replace the old 246.086 s / 12.861 s historical tails; workloads differ,
so this is not presented as a statistically controlled speedup.

Generated per-attempt/per-request timelines cover launch through rendered
availability. Maximum residual native local execution is below 0.36 s,
contact local HTML/control gaps below 0.21 s, workflow handoffs below 0.07 s,
and Temporal activity queue below 0.12 s. No unassigned interval exceeds
10 seconds at these named-span boundaries. Fully splitting remote-provider
poll HTTP versus sleep remains a finer-grained diagnostic improvement,
not a claim of already measured remote compute.

The old `result_summary.recommendationQueueMs` includes user time between
seed confirmation and Generate (311398 ms for Manitosilk). It is explicitly
excluded from these gates; actual scheduled-to-start is taken from the
durable workflow events. Updating that legacy display/summary semantic is
tracked separately rather than silently changing old audit facts.

After these two samples, set a **bounded local regression target** for this
same one-batch/three-new-contact workload: ACK <=2 s, healthy worker start
<=10 s, last contact terminal to publication <=6 s, publication to rendered
availability <=3 s, and first rendered availability <=6 minutes. These
observations are not a p95/p99 estimate or an SLO for full twenty-contact
batches. Provider/site latency and blocked capacity must remain visible.

### Verification and Shutdown

| Verification in this execution | Result |
| --- | --- |
| Core unit + contract | 213 files / 1450 tests PASS |
| Core API | 36 files / 161 tests PASS |
| Combined current Core tests | 249 files / 1611 tests PASS |
| Current captured-history replay | 63/63 PASS: 5 generation + 58 contact histories |
| Fresh real histories within that replay | 2 generation + 8 contact histories |
| Core typecheck and changed-file ESLint | PASS |
| Core build and running build-identity check | PASS |
| git diff --check | PASS; existing LF/CRLF warnings only |
| Real browser launch through feed observations | Both samples PASS |
| Final native jobs / contact jobs / reservations active | 0 / 0 / 0 |
| Seven-project V2 feed HTTP / contract verification | 7/7 HTTP 200; 7/7 valid V2 active |
| Active V1 work / immutable history protection | zero active; 18 freeze triggers; 13 history records |

The production contact timing addition changes activity results only;
it does not change workflow control flow. Current and historical captured
histories all replay against the current workflow bundle. Core source
fingerprint is
`328cfffb77171f120e12dbd1857852621ce0c809af94397cacd4ff2a3d110537`;
artifact fingerprint is
`6c759f94187288cc0ba7ae49e1f5bc32dde467f2c89d0a6cfe754641fcb1ae11`.
API and worker report build
`local-product-328cfffb77171f120e12dbd1`.

At 02:36 UTC, after both samples and all contacts became terminal, the
runtime was restarted with DataForSEO explicitly blocked again. AI,
browser provider and Gmail remained blocked throughout. At 02:44 UTC the
API, gateway and worker were healthy; four unrelated older AI
WAITING_PROVIDER jobs were preserved. Ledger counts are 273 total, provider
requests 288, batch requests 250: exactly eight above the starting counts.

No full Gate 8 database integration/security/load suite, frontend full
suite or Python suite was rerun in this bounded real closure; section 72
records their earlier evidence where applicable. The new execution guard
has focused unit and real reservation coverage, not a separate multi-process
PostgreSQL contention test. No Gmail send, commit, push, deployment or human
UAT occurred.

Reproducible artifacts are under
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-7-REAL-002/`:
start-card.md, restart.ps1, browser-capture.mjs/browser-traces.json,
capture.mjs, snapshots, generation/contact histories, analyze.mjs,
timing-summary.json, per-generation timing reports, replay.mjs/
replay-results.json, audit.mjs/v2-audit.json and
final-runtime.mjs/final-runtime.json.

## 74. V2 Recommendation Pool Usability Decision

**NOT READY for an unqualified "normally and smoothly usable" product claim.**
Gate 7 PASS is a latency-observability/sample result, not a waiver of
recommendation quality or actionable contact requirements.

The final read-only seven-project audit has 120 visible rows, with no
remaining pagination cursor. All 120 are marked recommended; all 120 have
null category and all three authority/traffic/spam metrics null. Only 17
rows contain an email. Thirteen rows claim PUBLIC_EMAIL_FOUND while email
is null (Awolvision six, Everycine seven). Twenty rows claim
CONTACT_FORM_ONLY without a contact-page URL. These counts are field
consistency findings, not estimates of verified email deliverability.

Shared admission currently derives broad relevance/evidence signals from
discovery source type, accepts country-code presence as market/language
evidence, and passes an empty hard-exclusion signal set. This is insufficient
to establish that every displayed domain is a useful outreach partner.
The existing contact form detector can match generic forms; publication
can retain a form-only outcome without an actionable source URL. V2-only
routing and successful publication do not correct either problem.

Prioritized, budget-conscious remediation and acceptance criteria are in
`docs/execution/backlinks-recommendation-pool-v2-usability-review-20260908.md`.
Fix shared semantics/projection and test against existing facts before any
new paid discovery. Do not buy more SERP pages to conceal quality gaps.
