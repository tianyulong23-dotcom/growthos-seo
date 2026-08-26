# Backlinks Phase 10 Release Candidate Evidence

- Task: `BL-AI-197`
- Date: `2026-07-30`
- Result: `PASS_DEVELOPMENT_ONLY`
- Preconditions: `BL-AI-180..196 = DONE`
- Git HEAD: `8e056945975093c2c720e944fca6666c2638ece3`

## Verification

| Area | Command or proof | Result |
| --- | --- | --- |
| Core | `npm run verify:backlinks` | PASS: typecheck, ESLint, source manifest 26, dependency allowlist, 642-package license inventory, Backlinks OpenAPI 45 paths, 25 migrations through `0032`, Unit 71 files/397 tests, API 30/86, Contract 20/144, Integration 47 passed files plus 4 skipped with 171 passed and 13 skipped tests, Security 9/102, Resilience 3/8 |
| Production dependencies | `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| Supply chain | focused Vitest plus deterministic SBOM rebuild | PASS: 4 files/22 tests; CycloneDX 1.7 contains 629 exact components and 0 sensitive fields; SBOM, NOTICE, lockfile, and source-manifest hashes were unchanged |
| FastAPI | locked Python 3.13/uv container: Ruff, Pytest, shared contract checker | PASS: Ruff clean; 34 passed, 1 skipped; aggregate OpenAPI 67 paths/72 operations, 1 cross-module command, 1 cross-module event, 4 module Task Queues |
| Shared runtime | `backend/api/scripts/check_shared_runtime_isolation.ps1` | PASS after replacing the stale 7-route assertion with the frozen 45-route count; command count 1; health/audit stayed 200 after Core stop; Backlinks returned 503 |
| PostgreSQL 18 | `backend/database/tests/verify-postgresql18.ps1` | PASS on PostgreSQL 18.4: clean install, historical upgrade through `0032`, DataForSEO write compatibility, backup/restore, contracts, and RLS; 68 table counts and 3 facts matched; RPO 0.255s, RTO 49.907s |
| Shared Crawler | pinned Go 1.25.4 image at digest `698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d` | PASS: `go test ./...`, `go test -race ./...`, and `go vet ./...`; Browser disabled |
| Frontend | Outreach source tests, typecheck, ESLint, Vite build | PASS: 40/40 tests; Vite 8.1.5 transformed 2310 modules |
| UI E2E | desktop, mobile, keyboard/a11y Playwright suites, serial with one worker | PASS: 1/1 each using local Chromium and intercepted local APIs; no non-local provider traffic |
| Rollback and Kill Switch | focused provider/send/Browser/Worker drill | PASS: 5 files/30 tests |
| Repository and cleanup | `git diff --check`, process/port/Docker/default-off audits | PASS: HEAD unchanged; current-task container/network residuals 0; product Browser/Crawler processes 0; Playwright port listeners 0 |

## Release Constraints

- `DATAFORSEO_ENABLED`, `GMAIL_ENABLED`, `GMAIL_SEND_ENABLED`, `GMAIL_SYNC_ENABLED`,
  `GMAIL_PUSH_ENABLED`, `CRAWLER_BROWSER_ENABLED`, and `BACKLINKS_WORKER_ENABLED`
  were not enabled.
- No real Gmail, Pub/Sub, DataForSEO, AI, Browser/provider, or production database
  call was made.
- Local Playwright Chromium was test tooling only and exited after every suite.
- The existing empty Docker network owned by `BL-AI-CC-003` was not changed.
- No commit or push was performed.
- This result is development-only evidence. Real-provider or production release
  authorization remains a separate explicit decision.

## Phase 10 Real-UAT Continuation - 2026-08-18

- Current result: `BLOCKED`.
- The historical `PASS_DEVELOPMENT_ONLY` above remains valid only for its
  original local test scope. It is not real-provider or CP11-CP14 acceptance.
- The recommendation supply implementation now:
  - uses competitor discovery only as a first-hop seed;
  - queries selected competitors through
    `/v3/backlinks/backlinks/live`;
  - creates competitor-derived candidates only from second-hop backlink
    observations;
  - carries source URL, target URL, anchor, active/lost state, first/last seen,
    and available HTTP status through API and UI;
  - reserves capacity across curated, competitor second-hop, user referring
    domain, and SERP sources;
  - keeps the fit threshold fixed at `55`;
  - uses persisted scoped raw-candidate totals.
- Focused verification passed:
  - recommendation tests: `8` files / `65` tests;
  - post-boundary-fix subset: `4` files / `29` tests;
  - Core typecheck and production build;
  - Backlinks OpenAPI `78` paths;
  - Platform contract `237` paths / `267` operations;
  - generated frontend client `79` operations;
  - frontend source tests, typecheck, and production build.
- The managed normal Worker automatically started a refill without a manual
  refill HTTP command.
- Three real DataForSEO qualification calls completed:
  - bulk traffic estimation: `12120` micros;
  - bulk spam score: `24036` micros;
  - bulk ranks: `24036` micros.
- Incremental cost: `60192` micros / `$0.060192`.
- New DataForSEO `task_post`: `0`.
- No first-hop competitor call or second-hop `backlinks/live` call was reached,
  so no real ElephTV page-level recommendation evidence was produced.
- Persisted contract
  `d435e76d-ae8e-558d-8437-aa4c10c8e84b` uses
  `recommendation-commercial-fit.v3`; the corrected runtime requires v4.
  The refill fails with
  `Corrected recommendation generation contract is incompatible.`
- Five monitor-created jobs failed the same root cause and a sixth remained
  persisted as running when the Worker was stopped. The UAT stop condition was
  therefore met.
- Current safe runtime:
  - Frontend `5173`, Platform `7200`, Core `7301`, Worker health `7302`:
    HTTP `200`;
  - build `local-product-6c17bea6847020ebf3609619`;
  - runtime `maintenance`;
  - Worker `quiesced`, business consumers stopped;
  - DataForSEO explicitly blocked;
  - provider requests after quiesce `0`.
- Provider totals for ElephTV:
  - DataForSEO usage rows `7`, all settled;
  - reserved `0`, unknown charge `0`;
  - all-time actual cost `62592` micros / `$0.062592`;
  - AI `0`, Gmail read/sync `0`, Gmail send/Send Intent `0`, other paid
    providers `0`, emails sent `0`.
- CP11, CP12, CP13, and CP14 remain `NOT RUN` on real business data because no
  real recommendation-to-Opportunity-to-reply-to-Placement chain exists.
- No migration history or authoritative business data was modified. No new
  Phase was declared, and no merge, commit, push, pull, reset, checkout, or
  clean was performed.

## Website Project Recommendation Projection Follow-Up - 2026-08-18

- Scope remained Website Project evidence to recommendation discovery and
  recommendation-pool projection. CP11-CP14, Gmail, paid refill, and
  authoritative-data repair were not run.
- Minimum required evidence is project identity, current Site Profile theme
  and language, one real promotion topic or published target, and matching
  project/profile/promotion versions.
- Keywords, Content/audit, competitor, and GSC are optional enhancers. Missing
  optional evidence disables only the corresponding source plan; missing GSC
  alone does not block discovery.
- Existing artifact replay used zero Provider calls and produced `20` English
  queries with no raw Chinese partnership-goal phrase.
- Core focused verification remained `7` files / `66` tests plus typecheck.
- Platform projection/contract verification passed `8` tests and compileall.
- Runtime build was `local-product-f0da67d980504b5bf33ce1bb`; services were
  reachable, but runtime stayed `maintenance`, Worker `quiesced`, business
  consumers stopped, and DataForSEO explicitly blocked.
- Runtime recommendation reads failed twice in the same strict-body projection
  mechanism:
  - outbox version `4` exposed internal `sharedEvidence`;
  - outbox version `5` exposed top-level `authorizedDiscoverySources`;
  - both were rejected as HTTP `400 BACKLINK_INVALID_REQUEST`.
- Both field leaks are fixed and test-covered. Per the repeated-root stop rule,
  there was no third runtime attempt, so the final source state is not runtime
  accepted.
- Provider rows and cost after `2026-08-18 15:00:00 UTC`: `0` and `$0`.
  Historical ElephTV DataForSEO usage remains `7` settled rows / `$0.062592`.
- Gmail read/sync `0`, Send Intents `0`, send attempts `0`, emails sent `0`,
  AI calls `0`, and other paid Provider calls `0`.
- CP11-CP14 remain `NOT RUN`. Current result remains `BLOCKED`; no new Phase
  was declared and no merge, commit, push, pull, reset, checkout, or clean was
  performed.

## Zero-Provider Runtime Projection Acceptance - 2026-08-18

### Code

- Restarted Platform loaded the final projection source SHA-256
  `b32dccfa06c4871b48fff94badc38e71ad42ec17e6c5616370ead03aed9f9437`.
- Top-level `sharedEvidence` and `authorizedDiscoverySources` are absent from
  the strict Core request; their owned nested contracts remain present.

### Test

- Platform projection/contract suite: `8` passed.
- Core focused recommendation suite: `7` files / `66` tests passed.
- Core typecheck passed. No full-repository suite was run.

### Runtime

- Core build: `local-product-f0da67d980504b5bf33ce1bb`.
- Runtime: `maintenance`; Worker: `quiesced`;
  `business_consumers_running=false`; DataForSEO: `explicit_block`.
- Exactly one ElephTV recommendation-pool read returned HTTP `200`,
  `items=[]`, and the correct organization/workspace/project metadata.
- Platform outbox version `6` was published and accepted.
- Core persisted project context version `6`, Site Profile version ID
  `1d93aee2-01be-4b47-b8fc-2a5ea15738da`, Promotion Target version ID
  `51c3c8c5-76a1-4461-b973-7825afad484a`, immutable outreach profile
  `dd4d02de-cd1e-5c00-9bf5-419eb1f65041`, shared evidence
  `d841f82e-c281-5ba7-aafc-6b56a639addc`, and immutable generation pin
  `98107bbc-47f4-5fde-9772-2293de3f083f`.
- The persisted profile uses domain `elephtv.com`, language `en`, market `ZA`,
  and exactly the five upstream promotion keywords. No Backlinks-generated
  expansion or fake pin is present.
- Missing keyword/content/competitor/GSC evidence disabled those optional
  plans. Minimum sufficient evidence passed with only
  `WEBSITE_PROJECT` and `CURATED_RESOURCE_LIBRARY` authorized.
- Current context version `6` has zero discovery batches, zero commercial
  candidates, zero recommendation inventory rows, and
  `last_raw_candidate_count=0`. The historical `22` candidates remain scoped
  to context version `3` and do not populate the current-run count.

### Provider

- Incremental DataForSEO/AI/Gmail/other paid Provider calls: `0`.
- Incremental cost: `$0`.
- Historical ElephTV DataForSEO ledger remained `7` rows / `62592` micros.
- Gmail read/sync `0`; Send Intents `0`; send attempts `0`; emails sent `0`.

### Product Acceptance

- Website Project evidence projection and recommendation-pool reading are
  runtime-accepted.
- The GET also created refill
  `3669edd5-d796-42e9-9ab2-3860beeeab86`, queued job
  `72debbdc-cc32-40e4-a71e-61407271de35`, and pending refill outbox event
  `4647e887-2d24-4d8b-bc81-4cc972814717`.
- Worker quiescence prevented execution and Provider usage. No cleanup,
  second read, or follow-on fix was attempted.
- Because the read violated the required no-refill boundary, the result is
  `BLOCKED`. Real recommendation supply remains unverified; CP11-CP14 remain
  `NOT RUN`; Phase 10 is not `COMPLETE`.

## Read-Path Refill Safety Closure - 2026-08-18

### Code And Trigger

- The single successful recommendation GET caused Platform project context
  version `6` to be accepted by Core. The new complete `ACTIVE` projection
  then entered
  `project-context-projection.command.ts::requestInitialGeneration`, which
  called `requestRefill` with trigger `inventory_low`.
- The request identity was
  `project-bootstrap:68299b17-33d6-4993-b106-cf24f1f880bc:6`; its refill
  window was
  `project-bootstrap:68299b17-33d6-4993-b106-cf24f1f880bc:6:g1`, generation
  `1`, and low/high watermarks `9/10`.
- A normal business Worker can claim the refill outbox, start the Temporal
  recommendation-refill workflow, and reach the DataForSEO execution activity
  after supply planning.

### Exact Side Effect

- Scope:
  - organization `11111111-1111-4111-8111-111111111111`;
  - workspace `22222222-2222-4222-8222-222222222222`;
  - Website Project `68299b17-33d6-4993-b106-cf24f1f880bc`;
  - recommendation context
    `db5f1798-7c6c-4216-8726-bf97a1aa62dc`, snapshot version `6`.
- Refill `3669edd5-d796-42e9-9ab2-3860beeeab86`: version `1`, generation `1`,
  trigger `inventory_low`.
- Job `72debbdc-cc32-40e4-a71e-61407271de35`: version `1`, status `queued`,
  empty step, progress `0`.
- Refill outbox `4647e887-2d24-4d8b-bc81-4cc972814717`: event
  `backlinks.recommendation-refill.requested.v1`, aggregate version `1`,
  status `pending`, attempts `0`.
- Project-analysis outbox
  `216246ae-dd61-40e7-9b39-f1b499861dbd`: status `pending`.
- The inventory policy has no standalone UUID. Its composite key is the four
  scope identifiers above. Policy version `2` is visible generation `1`,
  visible state `building`, refill state `running`, tier
  `exact_product_target_market`, round `1`, with
  `last_raw_candidate_count=0`.

### Termination Audit

- The only formal cancellation-like endpoint is
  `POST .../recommendation-refill-jobs/{jobId}/close-duplicate`.
- It applies only to a failed duplicate with no Provider artifacts and a
  separate successful canonical owner that has completed candidates and
  `addedCount > 0`.
- This job is the unique `queued` job and has no canonical duplicate, so the
  endpoint is inapplicable. Calling it would misrepresent the business event.
- No general refill cancel, pause, or terminal-failure command exists. Internal
  repository transitions and workflow failure activities are not an
  authorized cleanup interface.
- Therefore no command was invoked. No manual SQL, second read, refill, or
  Provider request was performed.

### Runtime And Provider

- Frontend, Platform, Core, and Worker health returned HTTP `200`.
- Build:
  `local-product-f0da67d980504b5bf33ce1bb`.
- Runtime remains `maintenance`; Worker remains `quiesced`;
  `business_consumers_running=false`; DataForSEO remains `explicit_block`.
- The post-read snapshot recorded zero incremental DataForSEO requests,
  batches, or ledger entries. Incremental Provider calls remain `0` and
  incremental cost remains `$0`.
- Gmail read/sync `0`; Send Intents `0`; send attempts `0`; emails sent `0`.
- Current blocking is operational, not permanent terminalization. If normal
  business consumers are restored and DataForSEO becomes available, the
  pending outbox can be claimed and the refill can reach paid execution,
  subject to its supply and budget gates.

### Final Acceptance

- **Do not restore the Worker to normal/business consumers and do not remove
  the DataForSEO explicit block** while job
  `72debbdc-cc32-40e4-a71e-61407271de35` and outbox
  `4647e887-2d24-4d8b-bc81-4cc972814717` remain non-terminal.
- Required follow-up is an authorized code repair that separates read
  projection from refill scheduling and a formal auditable terminalization
  path for the already queued side effect. Neither was implemented in this
  constrained closure.
- Project evidence projection and recommendation-pool reading passed.
- A read-only GET unexpectedly producing a refill is a new safety defect.
- Real recommendation supply remains unverified. CP11-CP14 remain `NOT RUN`.
- Final result: `BLOCKED`.
