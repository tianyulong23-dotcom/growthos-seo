# PB-G-PHASE-GATES Result

Status: PASS_DEVELOPMENT_ONLY
Baseline date: 2026-07-29
Latest task: BL-AI-179
Recorded tasks: BL-AI-085, BL-AI-098, BL-AI-123, BL-AI-142, BL-AI-160,
BL-AI-179

## Scope

- Re-executed the Phase 04 gate after integrating BL-AI-CORR-3C-001 and the
  BL-AI-084 shared Assessment route.
- Covered SSRF and Browser-default controls, contact-purpose correction,
  Opportunity concurrency, Assessment persistence/API, migrations, shared
  contracts, and dependency governance.
- No Phase 04 production activation or frontend synchronization was performed.

## Preconditions

- `BL-AI-CORR-3C-001 = DONE`.
- `BL-AI-084 = INTEGRATED`.
- Private Fastify, public FastAPI, Backlinks OpenAPI, and aggregate Platform
  OpenAPI expose the same Assessment contract.
- Forward-only migration `backlinks-0011` is present in the deployment
  manifest and PostgreSQL verification chain.

## Verification

| Check                                    | Result                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Source manifest                          | 21 records passed                                                         |
| Dependency allowlist                     | PASS                                                                      |
| Third-party licenses                     | 603 packages passed                                                       |
| Unit                                     | 16 files, 106 tests passed                                                |
| API                                      | 17 files, 53 tests passed                                                 |
| Contract                                 | 13 files, 69 tests passed                                                 |
| Security                                 | 5 files, 89 tests passed                                                  |
| Resilience                               | 1 file, 3 tests passed                                                    |
| Integration                              | 31 files passed, 4 environment-gated skipped; 90 tests passed, 13 skipped |
| TypeScript typecheck and lint            | PASS                                                                      |
| Backlinks OpenAPI                        | 13 paths passed                                                           |
| Aggregate Platform contracts             | 35 public paths, 39 operations, 1 command, 1 event, 4 Task Queues         |
| FastAPI pytest                           | 30 passed, 2 database-environment skipped                                 |
| Ruff                                     | PASS with disposable `/tmp/ruff-cache`                                    |
| Migration checker                        | PASS                                                                      |
| PostgreSQL 18.4 manifest                 | 4/4 passed                                                                |
| PostgreSQL 18.4 clean contract           | 2/2 passed                                                                |
| PostgreSQL 18.4 upgrade contract         | 2/2 passed                                                                |
| PostgreSQL 18.4 restore contract         | 2/2 passed                                                                |
| Contact labelled-set quality             | Precision threshold `>= 95%` and Macro F1 threshold `>= 85%` passed       |
| Contact false-positive regressions       | 6/6 passed                                                                |
| Production dependency audit              | 0 vulnerabilities                                                         |
| Scoped whitespace and `git diff --check` | PASS                                                                      |

## Gate Decision

- SSRF and SafeFetch security regression: PASS.
- Go Crawler Browser default: PASS by static default-off source assertion and
  its existing regression test.
- Contact-purpose correction and unknown preservation: PASS.
- Opportunity concurrency and four-axis state preservation: PASS.
- Assessment persistence, API semantics, and shared routing: PASS.
- PostgreSQL 18.4 clean install, prior-head upgrade, backup, and restore: PASS.
- `BL-AI-085 = DONE`.
- Phase 04 Gate: `PASS_DEVELOPMENT_ONLY`.

## External Effects

- No real DataForSEO, Gmail, crawler, or other provider call.
- No supplied credential use.
- PostgreSQL and integration verification used disposable Docker resources.
- Locked Python test dependencies were downloaded into disposable containers.
- No production resource, frontend synchronization, Git commit, or push.

## Residual Limits

- The Go test suite was not dynamically rerun because Go is not installed
  locally; the gate used the accepted static default-off assertion and existing
  source regression.
- No authenticated production product E2E was run.
- BL-AI-086 was not started.

---

## BL-AI-098 Phase 05 Gate

Status: PASS_DEVELOPMENT_ONLY
Task: BL-AI-098
Prerequisites: `PB-B-DRAFT-BE = INTEGRATED`,
`BL-AI-096 = INTEGRATED`, `PB-FE-DRAFT = INTEGRATED`,
`BL-AI-097 = INTEGRATED`

### Scope

- Regressed the provider-neutral AI Draft contract, disabled-by-default real
  adapter shell, bounded structured-output repair, evidence allowlist,
  injection resistance, deterministic Prompt Builder, immutable Draft
  versioning, optimistic approval, backend-authoritative Draft reads, and the
  restricted Tiptap editor.
- Verified that Draft generation and editing remain separated from sending.
- Did not activate a real model, use a credential, invoke Gmail, or perform a
  production database/resource operation.

### Verification

| Check                                | Result                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Phase 05 focused suite               | 11 files, 60 tests passed                                               |
| Full Core gate                       | `npm run verify:backlinks` exited 0                                     |
| Unit                                 | 21 files, 138 tests passed                                              |
| API                                  | 19 files, 55 tests passed                                               |
| Contract                             | 14 files, 75 tests passed                                               |
| Integration                          | 34 files, 102 tests passed; 4 files/13 tests environment-gated skipped  |
| Security                             | 6 files, 95 tests passed                                                |
| Resilience                           | 1 file, 3 tests passed                                                  |
| Core typecheck and ESLint            | PASS                                                                    |
| Source/dependency/license governance | 21 manifest records, allowlist PASS, 603 licenses                       |
| Production dependency audit          | 0 vulnerabilities                                                       |
| Backlinks OpenAPI                    | 22 paths                                                                |
| Aggregate Platform contracts         | 44 public paths, 48 operations, 1 command, 1 event, 4 Task Queues       |
| FastAPI pytest                       | 32 passed, 2 database-environment skipped                               |
| Ruff                                 | PASS                                                                    |
| PostgreSQL 18.4                      | Manifest, clean install, historical upgrade, backup, and restore passed |
| Frontend                             | Typecheck, ESLint, Prettier, production build passed                    |
| Draft frontend contracts             | 3/3 passed                                                              |
| Tiptap pins                          | Required direct and transitive packages resolve to `3.28.0`             |
| Desktop/mobile browser workflow      | Load, save, approve, reload, read-only, and no-overflow checks passed   |
| Protected frontend hashes            | All six current protected hashes matched                                |

The frontend production build emitted only the existing non-blocking
large-chunk warning.

### Safety Decision

- AI structured output requires `requiresUserConfirmation=true`.
- `canAutoSend` is a literal `false` in the public AI Draft contract.
- The real adapter is disabled by default and contains no built-in provider
  network client.
- Raw webpage instructions remain untrusted evidence and cannot become system
  instructions.
- Unknown or malformed Draft document nodes/marks are rejected; raw HTML is
  neither persisted nor rendered.
- Save and approval require backend versions. Approval cannot bypass the
  current-version check.
- The Draft frontend has no send endpoint or automatic-send control.

### Gate Decision

- `BL-AI-098 = DONE`.
- Phase 05 Gate: `PASS_DEVELOPMENT_ONLY`.
- Draft AI contract, injection defense, immutable versioning, and human
  approval regressions pass.
- This result authorizes no real AI activation, automatic sending, production
  deployment, or product E2E claim.

### External Effects

- No real AI/provider/Gmail/Google call.
- No supplied credential or Secret Reference use.
- PostgreSQL and integration verification used disposable resources.
- No production resource mutation, Git commit, or push.

### Residual Limits

- Browser verification used a local deterministic Fake Draft API, not an
  authenticated production Gateway-to-Fastify product E2E.
- Real AI remains intentionally default-off and was not canary-tested.

---

## BL-AI-123 Phase 06 Gate

Status: PASS_DEVELOPMENT_ONLY
Task: BL-AI-123
Prerequisites: Gmail Auth (`BL-AI-099..106`), Gmail Send
(`BL-AI-107..120`), and Gmail frontend (`BL-AI-101..122`) integrated.

### Scope

- Regressed default-off Gmail auth/send adapters, OAuth state and opaque Secret
  Reference boundaries, approved Draft identity, suppression, connection-level
  quota, idempotent Send Intent creation, bounded retry, and unknown-send
  reconciliation behavior.
- Exercised the frontend's explicit two-step confirmation with a deterministic
  local API. The local drill creates a `READY` Send Intent only; it has no
  Gmail provider client or delivery behavior.

### Verification

| Check | Result |
| --- | --- |
| Full Core gate | `npm run verify:backlinks` exited 0 |
| Unit | 31 files, 192 tests passed |
| API | 20 files, 59 tests passed |
| Contract | 16 files, 96 tests passed |
| Integration | 36 files, 114 tests passed; 4 files and 13 tests environment-gated skipped |
| Security and resilience | 95 security and 3 resilience tests passed |
| Core governance | Typecheck, ESLint, 22-record source manifest, dependency allowlist, 604 licenses, Backlinks OpenAPI (23 paths), and migration checker passed |
| Shared FastAPI contracts | 17 passed (`test_shared_contracts`, `test_backlinks_gateway`, and `test_database_migration_system`) |
| Ruff | PASS |
| Frontend | Production build, ESLint, and 7 Gmail/Draft source-contract tests passed |
| Local confirmation drill | One explicit `POST /send-intents` with an idempotency key returned `READY`; the UI displayed it as not sent or delivered |

### Safety Decision

- Gmail auth and send adapters remain disabled by default.
- The frontend can create only a server-validated `READY` intent after the
  exact approved version, one candidate, an available Gmail identity, and an
  explicit confirmation. It cannot present `READY` as send success.
- The Send Policy Gate rechecks Draft approval, suppression, connection,
  quota, cooldown, and Kill Switch conditions server-side.
- Retry is bounded to three attempts and applies only to proven
  definitely-not-sent failures. Provider 5xx, timeout after dispatch, and
  malformed/ambiguous outcomes stay `DELIVERY_UNKNOWN` for reconciliation.
- Bulk and automated sending remain disabled.

### Gate Decision

- `BL-AI-123 = DONE`.
- Phase 06 Gate: `PASS_DEVELOPMENT_ONLY`.
- This authorizes no real OAuth, credential use, Gmail delivery, automated or
  batch send, production deployment, or product-E2E claim.

### External Effects

- The confirmation drill used a local deterministic API and browser only.
- No Google, Gmail, AI, or other provider call occurred.
- No credential, plaintext token, production database/resource mutation, Git
  commit, or push occurred.

### Residual Limits

- The PostgreSQL 18 contract test was not supplied
  `SEO4_INT_004_DATABASE_URL` during this gate and therefore skipped its two
  environment-gated cases.
- The browser drill is UI proof against a deterministic local API, not an
  authenticated production Gateway-to-Fastify E2E.

---

## BL-AI-142 Phase 07 Gate

Status: PASS_DEVELOPMENT_ONLY
Task: BL-AI-142
Prerequisites: Mail Sync/Reply (`BL-AI-130..139`), shared MIME dependency
(`BL-AI-131`), Email Center (`BL-AI-140`), and Gmail Push/relay
(`BL-AI-141`) integrated; Migration `0027` registered in the deployment and
PostgreSQL 18 verification chains.

### Scope

- Regressed bounded Gmail sync recovery, MIME parsing, fail-closed HTML
  sanitization, reply classification/matching, audited manual confirmation,
  mail list/detail/thread queries, authenticated Push ingress, Outbox
  deduplication, and the injected incremental-sync starter.
- Regressed the protected Email Center against local deterministic route
  fixtures at desktop and 390-pixel widths, including keyboard-only manual
  confirmation, pagination, sanitized HTML isolation, and forbidden state.
- No Phase 08 or later Gate was executed.

### Verification

| Check | Result |
| --- | --- |
| Phase 07 focused Core suite | 19 files and 86 tests passed |
| Full Core gate | `npm run verify:backlinks` exited 0 |
| Unit | 61 files and 368 tests passed |
| API | 26 files and 80 tests passed |
| Contract | 20 files and 144 tests passed |
| Integration | 44 files passed and 4 environment-gated files skipped; 149 tests passed and 13 skipped |
| Security and resilience | 97 security tests and 3 resilience tests passed |
| Core governance | Typecheck, ESLint, 26-record source manifest, dependency allowlist, 642-package license/NOTICE check, 38-path Backlinks OpenAPI, and 22 migrations through `0029` passed |
| Production dependency audit | `npm audit --omit=dev` reported 0 vulnerabilities |
| NOTICE and SBOM | Deterministic NOTICE SHA-256 `054A6580B744429BE9BA86551977857984B1EF362A7C7B34027FFEE1EEDDCF19`; CycloneDX contained 629 exact components, 0 sensitive fields, SHA-256 `069F6C6BF60C04831D5573AC631D8094FA21B46CA905EAC89B90DE397F6D322F` |
| Governance focused suite | Source, dependency, license/NOTICE, SBOM, and Temporal namespace tests passed 26/26 |
| FastAPI | Full pytest passed 34 with 1 environment-gated skip; full Ruff passed |
| Shared contracts | Aggregate OpenAPI validated 60 public paths and 64 operations with 1 cross-module command, 1 cross-module event, and 4 Task Queues |
| Event and Temporal registry | `backlinks.gmail-incremental-sync.requested.v1` is an owner-only Backlinks Outbox event; Backlinks remains on `growthos.backlinks.v1` |
| PostgreSQL 18.4 | Clean install, supported-head upgrade, table/RLS and cross-schema contract, DataForSEO write compatibility, backup, and restore passed |
| Frontend | Typecheck, ESLint, production build, scoped formatting, and 9 Gmail/Email Center source tests passed |
| Repository hygiene | `git diff --check` exited 0; no residual Phase Gate container or network remained |

The frontend production build retained only the existing non-blocking
JavaScript chunk-size warning.

### Browser Verification

Playwright exercised
`/projects/elephtv/backlinks/email` against local deterministic HTTP fixtures
on the existing Vite server. It did not call live Core or provider services.

| Scenario | Result |
| --- | --- |
| Desktop, `1440x1000` | Mail list and thread rendered; cursor pagination requested the returned cursor; no horizontal overflow |
| Low-confidence matching | A 25-percent candidate remained unassigned until the user selected it, entered a reason, and submitted the exact `expectedMatchStatus=CANDIDATES_READY` confirmation |
| Keyboard path | Tab, Space, text entry, and Enter completed the manual confirmation without pointer input |
| Sanitized HTML isolation | The body rendered only in a sandboxed, no-referrer iframe; an injected script was blocked and could not set a parent-window marker |
| Mobile, `390x844` | Email Center, paginated result, and confirmed state remained usable without horizontal overflow |
| Isolated `403`, `390x844` | The protected error state rendered without falling back to the removed mock mail presentation |

Evidence:

- `output/playwright/bl-ai-142-email-desktop-1440.png`
- `output/playwright/bl-ai-142-email-mobile-390.png`
- `output/playwright/bl-ai-142-email-mobile-403-isolated.png`
- `output/bl-ai-142-postgresql18.log`

### Safety Decision

- Gmail Push and the Gmail Sync Client Adapter remain disabled by default.
- The Push route writes only the registered deduplicated Outbox request; the
  module-private relay invokes only an injected incremental-sync starter.
- Strong thread/header evidence can match deterministically. Subject-only and
  other low-confidence evidence stays in `CANDIDATES_READY` and cannot
  auto-assign an Opportunity.
- Mail HTML remains untrusted and is exposed only after server sanitization;
  the frontend does not use `dangerouslySetInnerHTML`.
- The former protected workspace mail mock is no longer mounted. The
  standalone Phase 06 Send Review component remains outside this Gate and was
  not modified.

### Gate Decision

- `BL-AI-142 = DONE`.
- Phase 07 Gate: `PASS_DEVELOPMENT_ONLY`.
- Security, Contract, Workflow, UI, recovery, MIME/XSS, matching, and Email
  Center regressions passed.
- `BL-AI-143` and `BL-AI-160` were not executed by this Gate.

### External Effects And Residual Limits

- No real Gmail, Google Pub/Sub, DataForSEO, AI, object-storage, or production
  database call occurred.
- PostgreSQL verification used disposable local Docker resources. An earlier
  parallel controller invocation exceeded its wrapper timeout; the empty
  labeled network was removed and the authoritative isolated mandatory rerun
  completed successfully with exit 0.
- Four Core integration files/13 tests and one FastAPI test remain explicitly
  environment-gated. They are not counted as production proof.
- Browser verification used local route fixtures, not an authenticated
  production Gateway-to-Fastify product E2E.
- No production resource mutation, Git commit, or push occurred.

---

## BL-AI-160 Phase 08 Gate

Status: PASS_DEVELOPMENT_ONLY
Task: BL-AI-160
Prerequisites: `BL-AI-142 = DONE`, `BL-AI-144..158 = INTEGRATED`,
`BL-AI-158 contract correction = INTEGRATED`, and
`BL-AI-159 = INTEGRATED`; Migrations `0028/0029` are registered in the
deployment chain. Placement/Monitoring Events, Temporal bindings, OpenAPI, and
the shared Crawler boundary remain frozen. PB-D Draft/Reply Correction and
PB-E Monitoring Decision Correction were integrated before the Gate decision.

### Scope

- Regressed Placement creation and promotion, static initial validation,
  continuous monitoring, Changed/Lost/Recovered transitions, immutable
  evidence reads, and explicit reverification.
- Regressed SSRF and network controls, static-first Browser fallback policy,
  the shared Crawler adapter boundary, resilience behavior, and protected Links
  UI wiring.
- Reaccepted immutable Draft approval, common AUTO/MANUAL Reply assignment,
  and one-decision-fact-per-Observation behavior before freezing Phase 08.
- No Phase 09 or later task was executed.

### Integrated Fact Acceptance

- Draft approval is fully reconstructible from the immutable
  `draft.approval.recorded` fact snapshot.
- AUTO and MANUAL Reply assignment use the same
  `reply-assignment-fact.v1` contract.
- Every completed Monitoring Observation produces exactly one immutable
  `placement.monitoring.status_decided` fact.
- Historical `suspected_lost` replay uses the policy thresholds captured by
  the decision fact and does not reread the current mutable policy.
- `inaccessible` and error outcomes preserve state; one absent result can
  produce `suspected_lost` but cannot confirm `lost`.

### Verification

| Check | Result |
| --- | --- |
| Full Core gate | `npm run verify:backlinks` exited 0 |
| Unit | 62 files and 370 tests passed |
| API | 26 files and 80 tests passed |
| Contract | 20 files and 144 tests passed |
| Integration | 44 files passed and 4 environment-gated files skipped; 157 tests passed and 13 skipped |
| Security and resilience | 97 security tests and 3 resilience tests passed |
| Combined PB-D/PB-E correction acceptance | 4 files and 27 tests passed |
| Placement static path | 8 files and 40 tests passed |
| Isolated monitoring decision workflow | 1 file and 10 tests passed |
| Browser/SSRF policy proof | 11 files and 109 tests passed |
| FastAPI | Full pytest passed 34 with 1 environment-gated skip; full Ruff passed |
| Shared contracts | Backlinks OpenAPI validated 38 paths; aggregate OpenAPI/Event/Temporal contracts passed |
| PostgreSQL 18.4 | Deployment manifest, clean install, supported historical upgrade through `0028/0029`, DataForSEO write compatibility, backup/restore, database contracts, and RLS passed |
| PostgreSQL Placement integration | Migration `0028/0029`, monitoring, and reply-match repository suites passed 3 files and 25 tests |
| Shared Crawler | Pinned Go toolchain `go test ./...`, `go test -race ./...`, and `go vet ./...` exited 0 |
| Frontend | Typecheck, ESLint, production build, and Links source contracts 5/5 passed |
| Supply chain | Production dependency audit reported 0 vulnerabilities; CycloneDX contained 629 exact components and 0 sensitive fields |
| Repository hygiene | Final documentation diff check passed; no labeled PostgreSQL gate container or network remained |

The frontend production build retained only the existing non-blocking
JavaScript chunk-size warning.

### Placement And Monitoring Proof

- Placement creation reaches the frozen initial-validation Workflow and the
  complete static evidence path without Browser use.
- A single failed or inaccessible observation preserves the current Placement
  state. `Lost` requires two qualifying matching absence observations.
- Changed, Lost, and Recovered are separate immutable lifecycle facts.
  Recovered filtering is derived from the recorded recovery fact.
- Evidence reads are project-isolated, opaque, hash-verified, and do not expose
  storage or provider secrets.
- Reverification requires project permission, `ExpectedVersion`, and a
  non-empty idempotency key, returns the existing Monitor Run state, and
  defaults `browserFallbackAllowed` to false.

### Browser And Boundary Proof

- The default product Browser process count was 0. Unrelated interactive user
  Chrome processes were excluded from product attribution.
- Browser fallback is permitted only when static evidence is insufficient and
  the request carries explicit authorization and budget.
- Backlinks owns no Browser Worker, Browser Queue, Browser Launcher, executable
  launcher, or second network stack.
- Backlinks remains on `growthos.backlinks.v1`; shared Crawler Browser work
  remains on `growthos.crawling.v1` behind `crawler.evidence.v1`.
- Browser remains disabled by default. The UI check used deterministic local
  route fixtures and did not launch or call a product Browser runtime.
- DataForSEO provider registration, kill switch, protected source hashes, and
  compatibility contracts remain unchanged.

### UI Verification

Playwright evidence captured the protected Links view at desktop and
390-pixel mobile widths against deterministic local route fixtures. It proved
Candidate exclusion from successful KPI counts, static evidence, lifecycle
Changed/Lost/Recovered facts, hash-verified immutable evidence, and a `202`
reverify request with `ExpectedVersion=4`, a non-empty idempotency key, and
`browserFallbackAllowed=false`. Keyboard dismissal/focus behavior and
horizontal-overflow checks passed.

Evidence:

- `output/playwright/bl-ai-160-links-desktop-1440.png`
- `output/playwright/bl-ai-160-links-mobile-390.png`
- `output/playwright/bl-ai-160-links-mobile-detail-390.png`
- `output/bl-ai-160-core-final.log`
- `output/bl-ai-160-postgresql18-final.log`
- `output/bl-ai-160-boundary-proof-final.log`
- `output/bl-ai-160-browser-process-final.log`

### Gate Decision

- `PB-D Draft/Reply Correction = INTEGRATED`.
- `PB-E Monitoring Decision Correction = INTEGRATED`.
- `BL-AI-160 = DONE`.
- Phase 08 Gate: `PASS_DEVELOPMENT_ONLY`.
- Core, FastAPI, OpenAPI/Contract, PostgreSQL 18, Security, Resilience,
  Frontend, shared Crawler, and required UI gates exited 0.
- `BL-AI-142` remains `DONE` under Phase 07 and is not blocked by these
  corrections.
- The BL-AI-161 business task and `BL-AI-179` were not executed.

### External Effects And Residual Limits

- No real Provider, Browser, Gmail, Google Pub/Sub, DataForSEO, AI,
  object-storage, or production database call occurred.
- PostgreSQL verification used disposable local Docker resources.
- Environment-gated tests are not counted as production proof.
- UI verification used deterministic local fixtures, not a production E2E.
- No migration was created; reserved `0030/0031` remain unused.
- No production resource mutation, Git commit, or push occurred.

---

## 2026-07-30 Phase 08 Reacceptance After BL-AI-161..176 Integration

Status: PASS_DEVELOPMENT_ONLY

The integration controller re-executed the Phase 08 development gate after
integrating PB-F. The original Placement/Monitoring behavior and immutable-fact
acceptance remain frozen; PB-F adds Metrics/Reports/Export/Settings composition
and the registered `0030/0031` migrations without changing the Browser,
Provider, Temporal, Event Registry, or DataForSEO boundaries.

### Verification

| Check | Result |
| --- | --- |
| Full Core gate | `npm run verify:backlinks` exited 0 |
| Unit | 70 files and 389 tests passed |
| API | 30 files and 86 tests passed |
| Contract | 20 files and 144 tests passed |
| Integration | 46 files passed and 4 environment-gated files skipped; 165 tests passed and 13 skipped |
| Security and resilience | 102 security tests and 8 resilience tests passed |
| PB-D/PB-E/PB-F PostgreSQL acceptance | 6 files and 35 tests passed |
| FastAPI | Full pytest passed 34 with 1 environment-gated skip; full Ruff passed |
| Shared contracts | Backlinks OpenAPI passed at 45 paths/46 operations; aggregate passed at 67 paths/72 operations |
| PostgreSQL 18.4 | Clean install and historical upgrade through `0031`, DataForSEO write compatibility, backup/restore, database contracts, and RLS passed |
| Frontend | Typecheck, production build, Links source contracts 5/5, and lint with one existing non-blocking Reports Hook warning passed |
| Shared Crawler | Pinned Go `1.25.4` test, race, and vet exited 0 |

### Fact Acceptance

- Draft approval remains fully reconstructible from immutable facts.
- AUTO and MANUAL Reply assignment still use the same fact contract.
- Every completed Monitoring Observation still produces exactly one immutable
  `placement.monitoring.status_decided` fact.
- Historical `suspected_lost` replay still uses captured policy thresholds;
  inaccessible/error and a single failure do not project confirmed `lost`.
- Candidate remains excluded from confirmed Placement KPI.

### Gate Decision

- `BL-AI-161..176 = INTEGRATED`.
- Backlinks migration head is `0031`.
- Metrics, Reports, Export, and Settings are registered in Fastify, FastAPI, and
  the shared OpenAPI.
- Phase 08 Gate remains `PASS_DEVELOPMENT_ONLY`.
- `BL-AI-142` remains `DONE` under Phase 07.
- Browser remains default-off. No second Browser Worker, Queue, Launcher, or
  network stack was created; DataForSEO remains unchanged.
- No real Browser, Provider, DataForSEO, production database, commit, or push
  occurred. `BL-AI-179` was not started.

---

## BL-AI-179 Phase 09 Gate

Status: PASS_DEVELOPMENT_ONLY
Task: BL-AI-179
Date: 2026-07-30
Prerequisites: `BL-AI-160 = DONE`, `BL-AI-161..176 = INTEGRATED`,
`BL-AI-177 = INTEGRATED`, and `BL-AI-178 = INTEGRATED`.

### Scope

- Regressed `DFS-COST-001..006`, Migration `0032`, DataForSEO compatibility,
  Provider Budget, global Lease, public Artifact and tenant Projection/Usage
  RLS, unknown-charge handling, Workspace-local Bulk, and SWR.
- Reaccepted the frozen Phase 08 Placement/Monitoring, Browser-default,
  shared Crawler, Temporal, Event, OpenAPI, Reports, and Settings boundaries.
- Used injected Provider functions, deterministic test fixtures, and
  disposable PostgreSQL/Docker resources only.

### Verification

| Check | Result |
| --- | --- |
| Preconditions | `BL-AI-160 = DONE`; `BL-AI-161..176`, `BL-AI-177`, and `BL-AI-178` are `INTEGRATED` |
| DFS cost-control acceptance | `DFS-COST-001..006 = INTEGRATED`; focused Unit passed 2 files/16 tests, PostgreSQL passed 1 file/6 tests, and established project-analysis workflow passed 1 file/3 tests |
| Full Core gate | `npm run verify:backlinks` exited 0 |
| Core governance | Typecheck, ESLint, 26-record source manifest, dependency allowlist, 642-package license check, 45-path Backlinks OpenAPI, and 25 migrations through `0032` passed |
| Core suites | Unit 71 files/397 tests; API 30/86; Contract 20/144; Integration 47 passed files plus 4 skipped with 171 passed and 13 skipped; Security 9/102; Resilience 3/8 |
| FastAPI | Locked Python 3.13 verification passed 34 tests with 1 environment-gated skip; full Ruff passed |
| Shared contracts | Aggregate OpenAPI validated 67 public paths and 72 operations, 1 cross-module command, 1 cross-module event, and 4 module Task Queues |
| Migration `0032` | Deployment head `0032`, prerequisite `backlinks-0031`, and SHA-256 `66dd40d4120b8899fb1eaac8e40f1166f10f79a902461772395841bf8d7d656c` passed |
| PostgreSQL 18.4 | Clean install, supported historical upgrade through `0032`, DataForSEO write compatibility, backup/restore, contract, and RLS gates passed |
| Frontend | Typecheck, ESLint, production build, 7 directed source files/29 tests, and changed-file Prettier for 19 files passed |
| Required UI | Existing integrated BL-AI-177/178 desktop and 390-pixel mobile Reports/Settings evidence was re-inspected; Phase 09 introduced no new UI surface |
| Shared Crawler | Pinned Go `1.25.4` test, race, and vet exited 0 |
| Supply chain | Production dependency audit reported 0 vulnerabilities; CycloneDX 1.7 contained 629 exact components and 0 sensitive fields |
| Repository hygiene | `git diff --check` exited 0 and no residual Docker container remained |

The frontend production build retained only the existing non-blocking
JavaScript chunk-size warning. A repository-wide optional Prettier diagnostic
reported the existing format baseline outside the Phase 09 changed-file gate;
all 19 changed frontend files passed the defined scoped formatting gate.

### Cost-Control Proof

- Existing `backlink_provider_budgets` and
  `backlink_provider_usage_ledger` remain authoritative. Reservation,
  exact settlement, known pre-dispatch release, and retained reservation for
  an unknown charge are covered.
- Migration `0032` enables and forces RLS on Provider Batch, public Artifact,
  Workspace Projection, Artifact Usage, and Provider Fetch Lease tables.
  Public Artifact columns exclude Organization, Workspace, and Website Project
  identity; tenant Projection and Usage records remain project-isolated.
- Global single-flight permits ordinary expired-lease takeover while an
  `unknown_charge` outcome blocks reacquisition pending reconciliation.
- Artifact completion is atomic across Batch, Artifact, Projection, Usage,
  Budget settlement, and Lease completion. Injected rollback proves no partial
  Artifact commit.
- Workspace-local Bulk preserves complete, negative, and partial item results,
  allocates actual cost exactly, rejects oversized batches before Provider
  dispatch, and retries temporary item failures only.
- Intent-specific freshness and negative-cache windows serve stale evidence
  through SWR while scheduling one bounded background refresh.

### Boundary Decision

- DataForSEO remains configured but default-off. Runtime source and test scans
  found no real DataForSEO endpoint; Provider execution is injected or mocked.
- Phase 08 Placement/Monitoring behavior remains frozen: static validation is
  complete, one failure cannot produce Lost, immutable Changed/Lost/Recovered
  facts remain authoritative, and Browser fallback remains explicit-only.
- No real DataForSEO, Provider, Browser, Gmail, Pub/Sub, AI, object-storage, or
  production database call occurred.
- No production resource mutation, credential use, Git commit, or push
  occurred. `BL-AI-180` was not started.

### Gate Decision

- `DFS-COST-001..006 = INTEGRATED`.
- Backlinks migration head is `0032`.
- All defined BL-AI-179 mandatory gates exited 0.
- `BL-AI-179 = DONE`.
- Phase 09 Gate: `PASS_DEVELOPMENT_ONLY`.
