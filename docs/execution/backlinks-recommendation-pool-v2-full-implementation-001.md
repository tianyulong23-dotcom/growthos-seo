# Backlinks Recommendation Pool V2 Full Implementation Evidence

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-FULL-IMPLEMENTATION-001`

Date: `2026-08-28`

Status: `PHASE_9_PASS_READY_FOR_SUPERVISOR_REVIEW`

## Global Boundary

- Repository: `C:\Users\DELL\Documents\缝合\john3947-seo-main`
- Branch: `main`
- Baseline HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Remote: `origin https://github.com/john3947/seo.git`
- Initial Backlinks migration file head: `0079`
- Initial deployment manifest Backlinks head: `0079`
- Commit/push ceiling: `0`
- Real DataForSEO/AI/Browser/Gmail/paid-provider call ceiling: `0`
- Allowed browser work: local Playwright against fixture/fake-backed local runtime only
- Prohibited roots: historical `link_outreach_platform`, `seo_auto_chengshida*`, deleted
  `john3947-seo`, and Compose project `growthos-live001`
- Current authorization stop point:
  `PHASE_9_PASS_READY_FOR_SUPERVISOR_REVIEW`. Migration 0085, the local product
  Phase 9 switch, the guarded Worker build replacement, and the bounded
  zero-side-effect observation are complete. Physical V1 cleanup, Phase 10,
  deployment, commit, and push remain prohibited.

## Phase 0 - Re-entry Audit

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-0-001`

Owned scope:

- architecture compatibility audit
- this execution evidence document
- read-only Git, migration, database, process, service, and port inspection
- V1/V2 contract-boundary and canonical-lineage test design

Database boundary: read-only.

Provider/AI/Browser ceiling: `0`.

Initial results:

- Git root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Branch/HEAD: `main` at `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Worktree was already dirty before this task: `71` tracked files modified plus `9`
  untracked files.
- Dirty areas include recommendation runtime, Workflow, commands, tests, OpenAPI,
  generated client, recommendation frontend, other Backlinks pages, OAuth/provider
  bootstrap, and dev startup configuration.
- There were no unmerged paths.
- Running related local services: PostgreSQL `5432`, Redis `6379`, MinIO
  `9000/9001`, Temporal `7233/8233`, frontend `5173`, Python API `7200`, core API
  `7301`, worker `7302`.
- An existing contact crawler process was already running before this task. It is
  outside this task's process ownership and must not be stopped or used as acceptance
  evidence.
- Local database facts before V2 migration: `7` active latest projects, `13`
  generation contracts, `0` active V1 refill jobs, `0` pending V1 refill outbox
  records, and no V2 release tables.
- Compatibility drift is recorded in section 20 of the coding plan.

Existing dirty paths were recorded with `git status --short` before edits. They are
treated as user-owned unless a later phase explicitly lists a surgical integration
change.

Required checks:

- V1/V2 contract guard unit/integration tests
- zero-side-effect tests for every V1 refill/recovery entry
- schema/FK proof for candidate, recommendation, prospect, inventory, generation
  contract, and input pin lineage

Exit criterion:

- no unexplained ownership conflict
- migration `0080` is available
- V1 entrypoints and guard locations are enumerated
- V2 Opportunity identity/FK contract is fixed
- contract-boundary tests are present

Current phase result: `PASS`

## Phase 1 - Additive Schema and Domain Policy

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-1-001`

Owned scope:

- `backend/core/src/modules/backlinks/db/migrations/0080_*`
- Backlinks deployment manifest entries for owned migrations
- new V2 domain policy modules and focused unit tests

Database boundary: additive columns/tables, RLS, indexes, constraints, functions,
and immutable/idempotency guards only. No V1 visibility switch.

Provider/AI/Browser ceiling: `0`.

Required checks: migration checker, fresh/upgrade migration tests, domain unit tests,
typecheck.

Exit criterion: V2 facts are representable with database-enforced scope and lineage;
all pure policies pass.

Current phase result: `PASS`

## Phase 2 - Seed Preparation

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-2-001`

Owned scope: new seed repository/service/commands/routes plus minimal existing
Blueprint/readiness wiring and focused tests.

Database boundary: seed facts and Blueprint seed references only.

Provider/AI/Browser ceiling: `0`; tests use deterministic fixture/fake AI candidates.

Exit criterion: valid empty-input projects receive evidence-backed fallback seeds,
unreliable inputs return `INPUT_REQUIRED`, and user inputs are never overwritten.

Current phase result: `PASS`

## Phase 3 - Discovery Budget and V1 Isolation

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-3-001`

Owned scope: V2 discovery policy/finalizer, shared provider-ledger integration, and
minimal guards at all V1 refill/recovery/reservation/relay/manual entrypoints.

Database boundary: V2 round and terminal generation facts; no manual data repair.

Provider/AI/Browser ceiling: `0`; provider behavior uses fake adapters and persisted
fixtures.

Exit criterion: round budgets are bounded, round fingerprints differ, unknown charge
stops, and every V1 entrypoint returns `contract_not_applicable` for V2 with zero
job/outbox/reservation/provider side effects.

Current phase result: `PHASE_3_PASS_READY_FOR_SUPERVISOR_REVIEW`

## Phase 4 - Canonical Batches and Contact Gate

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-4-001`

Owned scope: V2 finalizer/release repository and service, existing Contact Enrichment
source selection, recovery/deadline wiring, and tests.

Database boundary: canonical batch/item facts and release snapshots.

Provider/AI/Browser ceiling: `0`; contact tests use fake crawler fixtures.

Exit criterion: full lineage is materialized before preparation, only all-terminal
batches become available, deadlines converge to real partial outcomes, and current
plus next batch are prepared durably.

Current phase result: `PHASE_4_PASS_READY_FOR_SUPERVISOR_REVIEW`

### Phase 4 Canonical Batch PostgreSQL Gate - 2026-08-30

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-4-001`

Ownership and changed paths:

- `W5_PHASE4_OWNED`: the new disposable PostgreSQL integration
  `backend/core/test/backlinks/integration/recommendation-pool-v2-phase4-canonical-batch.test.ts`;
  the exact persisted generation-lineage and deadline-locking hunks in
  `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts`;
  and the exact V1/V2 contact recovery ordering assertion in
  `backend/core/test/unit/production-runtime.test.ts`.
- `PRE_EXISTING_USER_OWNED`: all other workspace changes. The checkpoint did
  not clean, revert, rename, or format them.
- `W5_PRIOR_OUT_OF_PHASE_SIDE_EFFECT` / `DEFERRED_INERT`: existing Phase 5+
  feed, user-release, Opportunity bridge, API, Generated Client, frontend, and
  cutover files were not edited or activated.
- `OWNERSHIP_CONFLICT`: `0` for the exact Phase 4 hunks above.
- Current dirty ledger: `182` status entries (`102` tracked dirty and `80`
  untracked). The additional tracked entry is the focused V1 runtime regression
  assertion; unrelated dirty entries remain preserved.

Implementation and database evidence:

- Canonical finalization now validates the full generation/context/input-pin
  scope before reading completion facts.
- Deadline convergence locks exactly one or two selected batches, requires
  every target batch to remain `PREPARING`, compares the caller deadline with
  the persisted deadline, and uses database time to reject an unexpired batch.
- The forged-deadline regression targets only a genuinely `PREPARING` batch,
  still returns `RECOMMENDATION_POOL_V2_CONTACT_DEADLINE_MISMATCH`, and proves
  the pending job and batch state remain unchanged.
- The dedicated disposable PostgreSQL integration passed `2/2` in `6.24s`.
  It covers six-ID lineage and scope/FK isolation, stable canonical
  partitioning/fingerprints, concurrent idempotency, immutable membership,
  current-plus-next recovery, selected-only contact job/outbox creation,
  terminal gating, supersession, and real expired-deadline
  `COMPLETED_PARTIAL` convergence. Provider usage remained `0`.

Fresh verification:

- Phase 4 unit/registration/starter/workflow suites: `4/4` files and `19/19`
  tests passed.
- V1 runtime/contract regression initially exposed one stale source-shape
  assertion (`1/22` failed). The assertion was strengthened to require the
  production order `V2 recovery -> contract_not_applicable -> V1 fallback`
  within the tenant transaction; the rerun passed `2/2` files and `22/22`
  tests in `6.04s`. Production behavior was not weakened.
- Core TypeScript typecheck: exit `0`.
- Focused ESLint over the repository and two tests: exit `0`.
- The new PostgreSQL test passed Prettier. The focused V1 regression hunk is
  byte-equivalent to Prettier output. Whole-file formatting was not applied to
  shared dirty files; their unrelated baseline differences remain preserved.
- Explicit trailing-whitespace/final-newline checks for all three checkpoint
  files passed, and scoped `git diff --check` exited `0`.
- Production reachability is present:
  namespace -> Temporal starter -> durable V2 workflow -> registered Phase 4
  recovery activity -> canonical contact preparation -> existing contact
  runner with exact recommendation IDs and `sourceSelection: "canonical_v2"`
  -> V2 repository/finalizer.
- A focused production registration scan found no Phase 5 recommendation-feed,
  user-release, V2 Opportunity bridge, API, Generated Client, or frontend
  activation edge.

Side effects and layered status:

- `IMPLEMENTED`: `IN_PROGRESS` (Phase 4 database/contact/recovery gates are
  implemented; overall Phase 4 remains under supervisor review).
- `TESTED`: `IN_PROGRESS` (the dedicated database gate and focused regressions
  pass; this is not a Phase 4 or full-product PASS declaration).
- `LOCAL_RUNTIME`: `NOT_RUN`.
- `REAL_PROVIDER`: `NOT_RUN_REQUIRES_AUTHORIZATION`; real
  DataForSEO/AI/Browser/Gmail/Provider calls and cost were `0`.
- Product database migration apply/manual SQL, service start/stop,
  Temporal/Worker business runs, candidate fabrication, commit, push, and
  deployment: `0`.
- `DEPLOYMENT`: `NOT_RUN`.
- `HUMAN_UAT`: `NOT_RUN`.
- Phase 5 was not entered.

### Phase 4 Formatting Ownership Recovery - 2026-08-30

Task ID:
`BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-4-FORMATTING-OWNERSHIP-RECOVERY-001`

Ownership and changes:

- The user explicitly granted `USER_AUTHORIZED_FORMAT_ONLY` ownership over the
  current complete contents of `contact-enrichment.command.ts`,
  `production-runtime.ts`, `contact-enrichment-command.test.ts`, and
  `production-runtime.test.ts`.
- The user subsequently authorized the two minimal
  `USER_AUTHORIZED_TEST_CONTRACT_FIX` hunks in `production-runtime.test.ts`.
  They make source-text assertions insensitive to Prettier whitespace while
  retaining the exact production symbols, conditions, and ordering contracts.
- The repository Prettier command was applied only to the four authorized
  shared files. No production behavior, configuration, migration, or other file
  was manually edited in the recovery.
- The four-file Prettier check now exits `0`; ESLint exits `0`; Core TypeScript
  typecheck exits `0`; scoped `git diff --check` exits `0` with only the existing
  LF-to-CRLF working-copy warnings.

Fresh recovery verification:

- The initial post-format run passed `64/66` tests and exposed exactly two
  whitespace-coupled source assertions in `production-runtime.test.ts`.
- The first assertion now still requires `absoluteBudgetMicros` to bind to
  `persistentProviderBudgetGrant.maxCostMicros`. The second still requires the
  DataForSEO configuration, secret-store, availability, V1, and provider-order
  contract. Only whitespace matching changed.
- Focused `production-runtime.test.ts`: exit `0`, `1/1` file and `16/16` tests
  passed.
- The first complete rerun and first dedicated PostgreSQL rerun each observed a
  transient disposable-container `read ECONNRESET`. No timeout, retry, assertion,
  production code, or database contract was changed to mask those observations.
- The later dedicated disposable PostgreSQL Phase 4 integration rerun passed
  `1/1` file and `2/2` tests in `5.94s`.
- The final complete Phase 4 focused rerun passed `9/9` files and `66/66` tests
  in `14.75s`.
- Core TypeScript typecheck, four-file ESLint, four-file Prettier check, and
  scoped `git diff --check` all exited `0`.
- Production reachability remains
  starter -> workflow -> activity -> canonical contact source selection ->
  repository/finalizer, including registered recovery paths. The exact Phase 5
  publication/feed/Opportunity activation scan returned `0` matches.
- Real Provider calls and cost, product database writes, service or
  Temporal/Worker business runs, commit, push, and deployment were all `0`.

Recovery decision:

- Phase 4 is `PHASE_4_PASS_READY_FOR_SUPERVISOR_REVIEW`.
- This is a Phase 4 code/test result only. It does not authorize or claim Phase
  5 work, local product runtime acceptance, real-provider acceptance,
  deployment, or human UAT.

Layered result:

- `IMPLEMENTED`: `YES_PHASE_4_SCOPE`.
- `TESTED`: `PASS_9_FILES_66_TESTS`.
- `LOCAL_RUNTIME`: `NOT_RUN`.
- `REAL_PROVIDER`: `NOT_RUN_REQUIRES_AUTHORIZATION`; real Provider calls and
  cost were `0`.
- Product database migration apply/manual SQL, service start/stop,
  Temporal/Worker business runs, candidate fabrication, commit, push, and
  deployment: `0`.
- `DEPLOYMENT`: `NOT_RUN`.
- `HUMAN_UAT`: `NOT_RUN`.
- Phase 5 was not entered.

### Phase 4 Closeout Gate - 2026-08-30

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-4-001`

Ownership ledger:

- `W5_PHASE4_OWNED`: 15 new Phase 4 policy, repository, service, activity,
  workflow/starter, and focused test files. All 15 pass Prettier and contain no
  trailing whitespace.
- `W5_PHASE4_OWNED` shared hunks: only the Phase 4 contact source-selection,
  Temporal registration/export, production starter/recovery/activity
  registration, and focused source-order assertions in six tracked shared
  files. A scoped comparison confirmed these exact hunks are byte-equivalent
  to Prettier output.
- `PRE_EXISTING_USER_OWNED`: all other hunks in the six tracked shared files
  and all unrelated workspace changes. They were preserved without whole-file
  formatting, cleanup, reset, or overwrite.
- `W5_PRIOR_OUT_OF_PHASE_SIDE_EFFECT` / `DEFERRED_INERT`: Phase 5+ feed,
  publication/user-release, Opportunity bridge, API, Generated Client,
  frontend, and cutover files remain unedited and unactivated.
- `OWNERSHIP_CONFLICT`: the repository-wide whole-file formatting gate still
  includes non-Phase 4 hunks in exactly four shared files:
  `contact-enrichment.command.ts`, `production-runtime.ts`,
  `contact-enrichment-command.test.ts`, and `production-runtime.test.ts`.
  `workflows/definitions/index.ts` and `workflows/namespaces.ts` now pass the
  current Prettier check. Changing the four remaining shared-file differences
  would exceed Phase 4 ownership.
- Ending dirty ledger: `182` status entries (`102` tracked dirty and `80`
  untracked). No unrelated change was removed.

Fresh closeout verification:

- Supervisor independent rerun at `2026-08-30 17:13 Asia/Shanghai`: focused
  Phase 4 tests passed `9/9` files and `66/66` tests. Coverage includes the
  dedicated disposable PostgreSQL RLS/scope/FK and six-ID lineage gate, stable
  partition/fingerprint, idempotency/concurrency, immutable membership,
  supersession, terminal/deadline convergence, atomic `AVAILABLE`, durable
  current-plus-next preparation/recovery, selected-only contact job/outbox
  creation, production runtime wiring, and V1 isolation regressions.
- Core TypeScript typecheck: exit `0`.
- ESLint over the touched Phase 4 set: exit `0`.
- Current Prettier check: exit `1`, naming exactly the four shared files above.
  Phase 4-owned new files pass, and the exact Phase 4 hunks in shared files are
  formatter-equivalent. No whole-file `--write` was used on shared files.
- Scoped `git diff --check`: exit `0`; only LF-to-CRLF working-copy warnings
  were emitted. Phase 4-owned files contain zero trailing whitespace.
- Production call graph is registered and reachable:
  namespace -> Temporal starter -> V2 workflow -> registered preparation and
  recovery activities -> canonical contact preparation using exact selected
  recommendation IDs and `sourceSelection: "canonical_v2"` -> V2
  repository/finalizer.
- Phase 5 visibility/call-edge delta scan: `0`.

Blocking decision:

- Functional implementation and tests are complete, but Phase 4 cannot be
  declared PASS while the required whole-file Prettier command exits nonzero.
  The single required user decision is either (A) accept formatter-equivalent
  Phase 4-owned hunks as satisfying the formatting gate, or (B) explicitly
  grant ownership to format the four complete shared files.

Layered result:

- `IMPLEMENTED`: `YES_PHASE_4_SCOPE`.
- `TESTED`: `FUNCTIONAL_GATES_PASS_FORMATTING_GATE_BLOCKED`.
- `LOCAL_RUNTIME`: `NOT_RUN`.
- `REAL_PROVIDER`: `NOT_RUN_REQUIRES_AUTHORIZATION`; real Provider calls and
  cost were `0`.
- Product database migration apply/manual SQL, service start/stop,
  Temporal/Worker business runs, candidate fabrication, commit, push, and
  deployment: `0`.
- `DEPLOYMENT`: `NOT_RUN`.
- `HUMAN_UAT`: `NOT_RUN`.
- Phase 5 was not entered.

## Phase 5 - User Release and Opportunity Bridge

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-5-001`

Owned scope: publication/cursor/unlock/action repository and commands, actor archive,
canonical Opportunity V2 branch, and version-neutral Draft selection snapshot.

Database boundary: transactional user entitlement/action facts and existing
Opportunity insert path only.

Provider/AI/Browser ceiling: `0`.

Exit criterion: multi-device and multi-user isolation, 25 percent and 18-hour unlock,
idempotent one-batch get-more, creator-only numerator, and downstream contact gates.

Current phase result: `PHASE_5_PASS_READY_FOR_SUPERVISOR_REVIEW`

### Phase 5 execution evidence - 2026-08-31

Git baseline and closeout:

- root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- remote: `origin https://github.com/john3947/seo.git`
- branch / HEAD: `main` /
  `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- closeout status: `103` tracked dirty paths and `86` untracked paths; unrelated
  dirty work was preserved.
- migration head: `0081_backlink_recommendation_refill_atomic_preclaim.sql`.
  Phase 5 did not edit or apply a migration or the deployment manifest.

Ownership ledger:

- `W5_PHASE5_OWNED`: the new user-release route, command, service, repository,
  unlock policy, V2 Opportunity repository branch, and focused Phase 5 tests.
- `W5_PHASE5_OWNED` hunks in shared files: strict V1/V2 Opportunity create
  route and command branching, V2 Opportunity repository composition,
  version-neutral Draft selection evidence, private-server/runtime release
  composition, and route regression coverage.
- `USER_AUTHORIZED_FORMAT_ONLY`: on 2026-08-31 the user authorized repository
  Prettier over the current complete contents of `private-server.ts`,
  `opportunity-transitions-route.test.ts`, `private-server.test.ts`,
  `opportunity-commands.route.ts`, `opportunities.command.ts`,
  `draft-generation.repository.ts`, and `opportunity.repository.ts`. The
  authorization covered formatting only, not semantic changes.
- `PRE_EXISTING_USER_OWNED`: all semantic content outside the isolated Phase 5
  hunks in those seven shared files remained preserved. Whitespace-insensitive
  diff review retained the existing release registration, strict V1/V2
  Opportunity branch, Draft evidence, repository composition, and matching
  assertions without deleting exports, conditions, calls, or tests.
- `DEFERRED_INERT`: existing Phase 6 recommendation-feed query/command/route
  files. No product server, runtime, or workflow registration was added.
- `OWNERSHIP_CONFLICT`: `0` after the explicit format-only authorization.

Implemented behavior:

- actor-scoped initial publication, immutable cursor/unlock facts, 25 percent
  and 18-hour unlock, idempotent one-batch Get More, exhaustion, and
  archive/unarchive are transactionally implemented against the existing 0080
  facts.
- the registered Opportunity create route accepts exactly one of V1
  `recommendationId` or V2 `recommendationFeedItemId`. The V2 branch validates
  current actor entitlement and canonical lineage, inserts/reuses the existing
  canonical Opportunity, and appends `OPPORTUNITY_CREATED` only after an actual
  insert.
- V2 lifecycle evidence is consumed by the existing Draft repository without
  exposing hidden score facts. A no-email terminal item creates
  `contact_review_required`, while Draft and Send persistence remain empty.
- the release command-to-transactional-repository boundary is production
  reachable. The product runtime composes the repository and commands, the
  private API registers Phase 5-only release/status/Get More/archive routes,
  and status evaluates persisted actor facts through the frozen unlock policy.
- Recommendation-feed HTTP exposure remains intentionally deferred to Phase 6.

Fresh validation:

- Phase 5 focused unit, route, production-composition, and no-email downstream
  matrix was rerun from the current final contents with the eight files named
  explicitly: `recommendation-user-unlock-policy.test.ts` (`6`),
  `recommendation-user-release-command.test.ts` (`3`),
  `recommendation-pool-v2-application-services.test.ts` (`8`),
  `opportunities-command-v2.test.ts` (`7`),
  `opportunity-transitions-route.test.ts` (`1`),
  `recommendation-user-release-route.test.ts` (`2`),
  `private-server.test.ts` (`4`), and `opportunity-handoff.test.ts` (`9`).
  Vitest returned `8` files / `40` tests passed. The `7` files / `39` tests
  subset excludes the one-test `opportunity-transitions-route.test.ts` and
  already includes the nine handoff tests; adding the handoff file again would
  double-count it.
- Disposable PostgreSQL publication/cursor/unlock/action and Opportunity
  matrix: `1` file / `1` test passed in `7.71s`. It covers initial publication,
  actor and multi-device persistence, creator-only 25 percent numerator,
  server-clock 18-hour unlock, delete-no-relock, archive/unarchive,
  concurrent/double-click Get More, exhaustion, Opportunity
  transaction/concurrency/team reuse, canonical lineage, and no-email
  Draft/Send fail-closed behavior.
- V1 Opportunity and Gmail Send regression: `2` files / `24` tests passed.
- Core TypeScript typecheck passed.
- ESLint and Prettier passed for all `18` current Phase 5 dirty files. The
  unchanged tracked `opportunity-handoff.test.ts` remained part of the
  functional test matrix but was not rewritten under the format-only grant.
- scoped `git diff --check` passed; only line-ending conversion warnings were
  emitted for the seven tracked shared files.
- production registration scan proves
  `production-runtime -> createRecommendationUserReleaseRepository ->
  createRecommendationUserReleaseCommands -> private-server ->
  registerBacklinksRecommendationUserReleaseRoutes`. The release/status/Get
  More/archive route calls the command boundary; the status command calls
  `evaluateRecommendationUserRelease`.
- Phase 6 product registration scan returned
  `PHASE6_PRODUCT_REGISTRATION_MATCHES=0`.
- paid Provider/refill call-edge scan over Phase 5 release production files
  returned `PHASE5_RELEASE_PAID_PROVIDER_EDGE_MATCHES=0`. Real DataForSEO, AI,
  Browser, Gmail, product-database, service, Temporal, commit, push, and
  deployment side effects were `0`.

Exit criteria:

- functional Phase 5 implementation and focused behavior: `PASS`.
- database isolation, idempotency, concurrency, and downstream gates: `PASS`
  in disposable PostgreSQL.
- V1 regression, typecheck, ESLint, complete touched-file Prettier, and scoped diff:
  `PASS`.
- ownership and formatting gate: `PASS`; the explicit user grant was limited to
  mechanical formatting of the seven named shared files.

Layered result:

- `IMPLEMENTED`: `PASS`
- `TESTED`: `PASS`
- `LOCAL_RUNTIME`: `NOT_RUN`
- `REAL_PROVIDER`: `NOT_RUN_REQUIRES_AUTHORIZATION`
- `SAMPLE_ACCEPTANCE`: `NOT_RUN`
- `DEPLOYMENT`: `NOT_RUN`
- `HUMAN_UAT`: `NOT_RUN`

Phase 5 is ready for independent supervisor review. Phase 6 was not entered.

## Phase 6 - Feed and Export API

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-6-001`

Owned scope: V2 query/command route family, OpenAPI contracts, generated client, and
API/integration tests.

Database boundary: read released actor entitlement only. Feed and export append no
publication, cursor, unlock, action, outbox, contact, discovery, or provider facts.

Provider/AI/Browser ceiling: `0`.

Exit criterion: database filtering/sorting/paging/export is entitlement-scoped,
limit is at most 100, and score/hidden/provider internals cannot leak.

Current phase result: `PHASE_6_PASS_READY_FOR_SUPERVISOR_REVIEW`

Execution date: `2026-08-31`

Implementation and production reachability:

- Added the V2 feed query, database repository, strict GET route, strict POST export
  route, focused unit/API/PostgreSQL tests, OpenAPI operations, and generated client.
- Production composition is
  `createRecommendationFeedRepository(pool)` ->
  `startBacklinksPrivateApi(... recommendationFeedRepository)` ->
  `registerRecommendationFeedRoutes(...)`.
- Feed reads every ACTIVE actor publication over historically released AVAILABLE V2
  batches in the requested tenant/workspace/project. A later project context,
  generation, contract, or input-pin binding does not remove an already released
  entitled item. The current project binding remains the V2 access gate and the
  cursor-freshness authority; stale cursors fail closed. Public `releasedAt`,
  `released_desc`, and release-order cursor positions use the actor publication's
  immutable `first_visible_at`, not canonical batch `available_at`; two actors that
  receive the same batch at different times retain distinct release timestamps.
  Hidden, PREPARING, unpublished AVAILABLE, other-scope, other-actor, and
  actor-archived items remain excluded in SQL.
- Filters, NULL semantics, stable ordering, total count, paging, selected/current
  filter export, domain-search escaping, and entitlement checks execute in PostgreSQL.
  Signed cursors bind tenant/workspace/project/actor/context/generation/contract,
  input pin, filters, sort, and limit.
- Public payloads expose only domain/display URL, recommendation reasons/category,
  allowed metrics/contact outcome, Opportunity state, archive state, and release time.
  Internal score, hidden counts, provider/cost facts, seed/blueprint facts, internal
  lineage, and internal failure evidence are not selected or serialized.

Ownership:

- `W5_PHASE6_OWNED`: recommendation feed query/repository/route, their unit/API/
  disposable-PostgreSQL tests, and the generated OpenAPI/client feed operations.
- `W5_PHASE6_OWNED` isolated hunks in shared files: private-server dependency/route
  registration, production-runtime repository composition, OpenAPI checker route
  registration, Phase 5 production-registration regression correction, and
  private-server operation registration assertions.
- `PRE_EXISTING_USER_OWNED` / prior shared hunks outside those isolated changes were
  preserved. The checker received only the Phase 6 route-registration and schema-only
  seed-registration hunks plus their local Prettier-equivalent formatting.
- `W5_PHASE6_OWNED`: canonical `platform.v1.json` aggregation, generated
  `frontend/src/api/generated/backlinks.ts`, the generated-client exact-union support,
  and the cache-independent generated-client TypeScript contract gate. The platform
  contract now contains the six authoritative Phase 5/6 feed operation IDs.
- Existing Phase 7 recommendation feed API/cache/state/hook files remain
  `DEFERRED_INERT`; no production file imports them.
- `OWNERSHIP_CONFLICT`: `0`. Phase 7 subsequently implemented and verified the
  deferred `ProjectQueryClient.activateScope` contract without changing the
  Phase 6 feed API, OpenAPI, or generated-client semantics.

Fresh verification:

- Red-to-green historical-scope regression: the PostgreSQL test first failed because
  the older released `stale.test` item was absent, then passed after removing only the
  current context/generation/contract/input-pin row predicates.
- Red-to-green release-authority regression: deliberately different batch
  `available_at` and database-authored actor `first_visible_at` values first produced
  `2 failed / 1 passed`; after changing the single selected release-time authority to
  `publication.first_visible_at`, the same disposable PostgreSQL suite passed `3/3`.
  It asserts actor-specific response timestamps, `released_desc` ordering, and
  cross-page cursor ordering.
- Phase 6 focused backend unit/API matrix: `4 files / 16 tests` PASS.
- Dedicated disposable PostgreSQL integration: `1 file / 3 tests` PASS. It proves
  historical released visibility, actor-specific publication timestamps,
  actor/tenant/workspace/project entitlement, hidden/unpublished/PREPARING exclusion,
  NULL semantics, stable database paging, stale/tampered/cross-actor cursor rejection,
  escaped domain search, export boundaries, concurrency, and zero publication/cursor/
  unlock/action/outbox/contact/provider-ledger deltas.
- Generated-client contract: `1 file / 2 tests` PASS.
- Phase 5 regression matrix, including the corrected production feed registration
  assertion: `8 files / 40 tests` PASS.
- V1 recommendations route/command regression: `2 files / 32 tests` PASS.
- Canonical Opportunity bridge disposable PostgreSQL regression: `1 file / 1 test`
  PASS.
- `npm run openapi:backlinks:check`: PASS, `90 paths`.
- `backend/api/.venv/Scripts/python.exe scripts/check_shared_contracts.py`: PASS,
  `252 public paths / 282 operations`.
- `npm run check:backlinks-client` from `frontend`: PASS, `92 operations`.
- `npm run check:backlinks-v2-contract`: PASS with `--incremental false`; the
  generated-client contract Vitest suite passed `1 file / 2 tests`.
- `npm run migration:backlinks:check`: PASS, `73 files through 0081`; no migration or
  manifest file was changed.
- Core `npm run typecheck`: PASS.
- Full frontend `npm exec -- tsc -p tsconfig.app.json --noEmit --incremental false`:
  PASS after the separately owned Phase 7 `activateScope` implementation.
- Current regression evidence also passes the Phase 7 focused matrix
  (`8 files / 27 tests`), V1 frontend matrix (`2 files / 6 tests`), and Node
  source tests (`3/3`), so the former deferred typecheck blocker is resolved.
- ESLint: all Phase 6 backend files and generated client/contract test PASS.
- Prettier: Phase 6 backend files, tests, checker, `backlinks.v1.json`, generated
  client, and generated-client contract test PASS when checked from their owning
  packages.
- Scoped tracked and untracked whitespace/diff checks: PASS; only LF-to-CRLF checkout
  warnings remain.
- Static call-edge scan found no feed query/repository/route edge to refill,
  discovery, contact enrichment, workflow, provider ledger, provider execution, or
  database mutation.
- Phase 7 production call-edge scan: `0` references outside the deferred frontend
  files themselves.

Side effects and layered status:

- Migration/manifest changes: `0`; product database writes/applies: `0`.
- Real DataForSEO/AI/Browser/Gmail/provider calls and cost: `0`.
- Service/Temporal/Worker operations: `0`; commit/push/deploy: `0`.
- `IMPLEMENTED=PASS`,
  `TESTED=PASS`,
  `LOCAL_RUNTIME=NOT_RUN_PHASE_6_SCOPE`,
  `REAL_PROVIDER=NOT_RUN_REQUIRES_AUTHORIZATION`, `DEPLOYMENT=NOT_RUN`,
  `HUMAN_UAT=NOT_RUN`.
- Phase 7 was completed as a separately owned phase; it removed the only recorded
  Phase 6 blocker without reopening Phase 6 behavior.

## Phase 7 - Frontend Switch

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-7-001`

Owned scope: recommendation V2 API hooks/workspace/tests and exact query invalidation.

Database boundary: none.

Provider/AI/Browser ceiling: `0`; browser tests are local fixture-backed Playwright.

Exit criterion: all recommendation UI reads V2, no score or V1 refill controls,
server-restored state, isolated caches, and responsive desktop/mobile rendering.

Current phase result: `PHASE_7_PASS_READY_FOR_SUPERVISOR_REVIEW`

### Phase 7 Execution Evidence - 2026-08-31

#### Git and ownership boundary

- Git root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Remote: `https://github.com/john3947/seo.git`
- Branch: `main`
- Start and end HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Final dirty ledger: `108 tracked + 96 untracked = 204`, `0 unmerged`.
- `PRE_EXISTING_USER_OWNED`: all unrelated dirty files and the pre-existing
  hunks in shared `outreach-workspace.tsx` and
  `recommendations-source.test.mjs` were preserved.
- `W5_PRIOR_OUT_OF_PHASE_SIDE_EFFECT`: the untracked recommendation-feed
  draft preimages were audited and were not accepted as completion evidence.
- `W5_PHASE7_OWNED`: only the Phase 7 query-scope, generated-client use,
  feed cache/state/hook/workspace, route switch, API client CSV handling,
  responsive header, focused tests, and fixture Playwright hunks listed below.
- `DEFERRED_INERT`: Phase 8 contact-review/send/cutover/full-migration files
  remain unregistered and unmodified.
- `OWNERSHIP_CONFLICT`: `0` for the exact Phase 7 hunks. No existing dirty
  content was cleaned, reverted, deleted, renamed, or whole-file formatted.

#### Changed files

- `frontend/src/api/client.ts`
- `frontend/src/api/client.test.ts`
- `frontend/src/app/app-shell.tsx`
- `frontend/src/features/outreach/api/project-query.ts`
- `frontend/src/features/outreach/api/project-query.test.ts`
- `frontend/src/features/outreach/outreach-workspace.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-feed-api.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-api.test.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-cache.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-cache.test.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-state.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-state.test.ts`
- `frontend/src/features/outreach/recommendations/use-recommendation-feed.ts`
- `frontend/src/features/outreach/recommendations/use-recommendation-feed.test.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.test.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-feed-production-wiring.test.ts`
- `frontend/src/features/outreach/recommendations/recommendations-source.test.mjs`
- `frontend/test/recommendation-feed-phase7.spec.ts`
- `docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md`

#### Implemented production path and boundaries

- `ProjectQueryClient.activateScope` aborts and removes superseded in-flight
  and cached project queries, so an old project/context response cannot write
  into the active scope.
- Production call graph:
  `outreach-workspace.tsx -> RecommendationFeedWorkspace ->
  useRecommendationFeed -> recommendation-feed-api.ts -> generated
  requestBacklinks -> Phase 5/6 recommendation-feed operations`.
- The workspace uses the generated list/status/get-more/archive/unarchive/export
  operations and the canonical Opportunity create operation. It does not
  hand-write generated-client operation contracts.
- Query keys and cursors bind actor, project, context, filters, sort, and cursor.
  Server refresh/remount restores state; stale responses fail closed.
- Recommendations now show only released public facts, null metrics as unknown,
  contact terminal state, Opportunity state, actor archive state, unlock
  progress/countdown, Get More, filters, sorting, paging, and export.
- Numeric/internal scores, hidden pool counts, Provider facts, cost/seed/blueprint
  lineage, and V1 refill controls are not rendered.
- Opportunity success invalidates only the recommendation feed and Opportunities.
  Opportunities, Mail, Links, and Reports data sources were not changed.
- Successful CSV export uses the generated client's declared string response
  through content-type-aware API client parsing.
- The responsive shell hides three nonessential header actions below `sm` while
  preserving the account action; desktop behavior is unchanged.
- No migration, backend Phase 1-6 semantic change, Phase 8 activation, commit,
  push, deploy, product database write, or real business task was performed.

#### Fresh verification

- Focused Phase 7 Vitest:
  `npm exec -- vitest run src/api/client.test.ts
  src/features/outreach/api/project-query.test.ts
  src/features/outreach/recommendations/recommendation-feed-api.test.ts
  src/features/outreach/recommendations/recommendation-feed-cache.test.ts
  src/features/outreach/recommendations/recommendation-feed-state.test.ts
  src/features/outreach/recommendations/use-recommendation-feed.test.tsx
  src/features/outreach/recommendations/recommendation-feed-workspace.test.tsx
  src/features/outreach/recommendations/recommendation-feed-production-wiring.test.ts
  --maxWorkers=1` -> exit `0`, `8 files / 27 tests`.
- CSV parsing regression was first reproduced as `1 failed / 5 passed`; after
  the content-type fix, `src/api/client.test.ts` passes `6/6`.
- V1/front-end source regression:
  `promotion-target-setup.test.tsx` and `recommendation-term-list.test.ts`
  separately pass `2 files / 6 tests`; `node --test
  recommendations-source.test.mjs` passes `3/3`.
- Cache-independent frontend typecheck:
  `npm exec -- tsc -p tsconfig.app.json --noEmit --incremental false` -> exit `0`.
- Generated contract gates:
  `npm run check:backlinks-v2-contract` -> exit `0`;
  `npm run check:backlinks-client` -> exit `0`, `92 operations`.
- Production build: `npm run build` -> exit `0`, `3823 modules transformed`.
  Only the existing dynamic-import and chunk-size warnings remain.
- ESLint: all `19` Phase 7 production/test files -> exit `0`.
- Prettier finalization
  `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-7-PRETTIER-FINALIZATION-001`:
  repository Prettier formatted only the current complete `project-query.ts`;
  exports, `activeScopes`, `activateScope`, guard/abort/delete behavior, and the
  existing 20-line Phase 7 semantic diff remained unchanged. No test or
  assertion was edited. The standard 19-file Prettier check exits `0`.
- Scoped `git diff --check` -> exit `0`; only existing LF-to-CRLF warnings.
- Local fixture Playwright:
  `PLAYWRIGHT_PORT=4197 npm exec -- playwright test
  test/recommendation-feed-phase7.spec.ts` -> exit `0`,
  desktop/mobile `2/2`.
- Desktop and mobile screenshots were inspected for loading, filters, sorting,
  paging, export, Get More, archive/unarchive, Opportunity, countdown, text,
  controls, overlap, and horizontal overflow. No overlap or overflow remained.
- The Playwright fixture intercepted all network requests and observed zero
  Provider/Workflow mutation edges. Static production scans found zero Phase 8
  contact-review/send/cutover/full-migration imports.

#### Layered result

- IMPLEMENTED: `PASS_PHASE_7`
- TESTED: `PASS_PHASE_7`
- LOCAL_RUNTIME: `PASS_LOCAL_FIXTURE_DESKTOP_MOBILE`
- REAL_PROVIDER: `NOT_RUN_REQUIRES_AUTHORIZATION`
- SAMPLE_ACCEPTANCE: `PASS_LOCAL_FIXTURE_ONLY`
- DEPLOYMENT: `NOT_RUN`
- HUMAN_UAT: `NOT_RUN`
- Provider/AI/Browser/Gmail paid calls: `0`; cost: `0`.
- Phase 8 was not entered.

## Phase 8 - Historical Compatibility and Full Migration

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-8-001`

Owned scope: additive migration/project contract binding, terminal-only legacy
projection, lazy member publication, and migration verification queries/tests.

Database boundary: product migration only; no manual SQL acceptance mutation and no
fabricated terminal/contact facts.

Provider/AI/Browser ceiling: `0`.

Exit criterion: every eligible non-deleted project is V2, active V1 generation is
zero, and `MIGRATION_BLOCKED` project count is zero.

Current phase result: `PHASE_8_BLOCKED_ORIGINAL_WORKER_RUNTIME_STALE`

### Phase 8 Execution Evidence - 2026-08-31

#### Git and ownership boundary

- Git root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Remote: `https://github.com/john3947/seo.git`
- Branch: `main`
- Start and end HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- `W5_PHASE8_OWNED`: additive `0082` migration, cutover
  repository/service/CLI, generation-version V1 read guard, focused unit and
  disposable PostgreSQL tests.
- `W5_PHASE8_OWNED` isolated shared hunks: the `0082` deployment-manifest entry
  and hash, package CLI script, V1 query guard calls, and legacy lazy-publication
  branch in the existing Phase 5 release repository.
- `PRE_EXISTING_USER_OWNED`: all unrelated dirty files and shared-file hunks were
  preserved. No clean/reset/checkout/revert/stash, deletion, rename, or whole-file
  formatting was performed.
- `OWNERSHIP_CONFLICT`: `0` for Phase 8 semantic hunks. The shared
  `recommendations.query.ts` whole-file Prettier baseline still differs outside
  Phase 8; in-memory comparison proves the Phase 8 import, capability, and both
  guard blocks are formatter-equivalent. All Phase 8-owned files pass Prettier.

#### Implemented production path and contracts

- Added forward-only
  `0082_backlink_recommendation_pool_v2_cutover.sql`; `0080` and `0081` were not
  edited. The manifest SHA-256 is
  `cad02d767c24b4c0e2b239037745103357d5457bb042a1dbbf7b18f8be7e8ed9`.
- Production administrative path is
  `package script -> run-recommendation-pool-v2-cutover.ts -> cutover service ->
  cutover repository -> 0082 append-only run/fact functions`.
- Cutover decisions use each project's immutable generation contract. There is
  no global blind V1-to-V2 switch and no Phase 9 V1-write freeze activation.
- V1 reads call `assertV1RecommendationPoolReadContract` before the existing V1
  list and inventory-status queries. V1 `CONTACT_PENDING` remains on the V1 read
  path; V2 and `MIGRATION_BLOCKED` fail closed.
- Legacy projection accepts only persisted terminal contact snapshots and writes
  `legacy_imported=true` canonical items with tenant/workspace/project/context/
  generation/contract/input-pin lineage. Missing lineage, non-terminal contact,
  stale context, cross-scope references, and already released canonical domains
  produce `MIGRATION_BLOCKED`; no email or terminal fact is fabricated.
- Duplicate released domains are checked under the project cutover transaction
  before projection; the existing database uniqueness constraints remain the
  concurrent authority. Existing Opportunity, archive, lifecycle, inventory, and
  V1 history remain unchanged.
- The existing production Phase 5 release composition performs an idempotent lazy
  publication for authorized members when a legacy-imported batch is first entered.
  It does not create a second crawler/provider path or request new discovery.
- The verifier reports active V1 projects/generations/refills/jobs/outbox/claims,
  provider requests/reservations/leases, and `MIGRATION_BLOCKED` projects. The
  disposable database reaches all-zero exit counts, but no product database was
  queried or mutated in this phase.

#### Fresh verification

- Phase 8/V1 focused matrix:
  `npm exec -- vitest run ... --maxWorkers=1` -> exit `0`,
  `8 files / 65 tests`.
- The matrix covers pure cutover/projection policy, terminal contact states,
  lazy publication, duplicate-domain blocking, history preservation, replay,
  recovery, stale generation, cross-scope fail-closed, V1 read isolation, CLI
  validation, and existing release-route behavior.
- Dedicated migration test: `1 file / 2 tests` PASS for fresh-through-0082,
  0081-to-0082 upgrade, idempotency, RLS, append-only immutability, function
  privileges/search path, scope/FK, and concurrent cutover facts.
- `npm run migration:backlinks:check`: PASS,
  `74 files through 0082`; manifest hash independently matches.
- Core `npm run typecheck`: PASS.
- Phase 8 TypeScript ESLint: `11` files PASS.
- Prettier: `10` Phase 8-owned/service/repository/test files PASS. The shared
  V1 query whole-file check retains a pre-existing formatting baseline; Phase 8
  import/capability/guard snippets each report
  `PHASE8_*_FORMAT_EQUIVALENT=True`.
- Scoped `git diff --check`: PASS; only existing LF-to-CRLF checkout warnings.
- Current Phase 7 regression: `8 files / 27 tests` PASS; V1 frontend:
  `2 files / 6 tests` PASS; Node source tests: `3/3` PASS.
- Full frontend cache-independent typecheck: PASS.
- `check:backlinks-v2-contract`: PASS;
  `check:backlinks-client`: PASS, `92 operations`.
- `openapi:backlinks:check`: PASS, `90 paths`; shared contracts: PASS,
  `252 public paths / 282 operations`.
- Core shared contract Vitest: PASS, `28 files / 203 tests`.
- Static scans report `PHASE8_REAL_PROVIDER_CALL_EDGES=0` and
  `PHASE9_PRODUCTION_CALL_EDGES=0`.

#### Side effects and layered status

- Product database migration apply/manual SQL/data repair: `0`.
- Real DataForSEO/AI/Browser/Gmail/provider calls and cost: `0`.
- Service/Temporal/Worker operations: `0`; commit/push/deploy: `0`.
- `IMPLEMENTED=PASS_PHASE_8_CODE`
- `TESTED=PASS_PHASE_8_DISPOSABLE`
- `LOCAL_RUNTIME=NOT_RUN_PRODUCT_DATABASE`
- `REAL_PROVIDER=NOT_RUN_REQUIRES_AUTHORIZATION`
- `SAMPLE_ACCEPTANCE=NOT_RUN_PRODUCT_MIGRATION_AUTHORIZATION`
- `DEPLOYMENT=NOT_RUN`
- `HUMAN_UAT=NOT_RUN`
- Phase 9 was not entered.
- The 2026-08-31 authorization blocker is superseded by the authorized 0084
  recovery and local product cutover evidence below.

### Phase 8 0084 Split Qualification Lineage Recovery - 2026-09-01

Task ID:
`BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-8-0084-SPLIT-QUALIFICATION-LINEAGE-RECOVERY-001`

- Added forward-only additive migration
  `0084_backlink_recommendation_pool_v2_split_qualification_lineage.sql`.
  Migration SHA-256:
  `aee96ef8f21ff18600e5cbf13020100c3aec704ee5e937104a81a35de68dddb3`;
  deployment manifest SHA-256:
  `7ade4ebcada06524b98bb283f6af82ec6eabe0b7d57631cfc05a919ceaf0b874`.
  Migrations `0080` through `0083` were not edited.
- Disposable PostgreSQL focused command passed with exit `0`: `6/6` files and
  `55/55` tests. It covers fresh-through-0084, 0083-to-0084 upgrade,
  manifest/hash, reapply/idempotency, search path, privileges, RLS, split
  qualification success, fail-closed missing/mismatch/cross-scope cases,
  lineage immutability/concurrency, and repository/catalog regression.
- `npm run migration:backlinks:check` passed with exit `0`:
  `76 files through 0084`. Core typecheck, touched-file ESLint, touched-file
  Prettier, and scoped `git diff --check` all passed with exit `0`.
- The repository standard runner from `scripts/dev-up.ps1:520-546,1470-1504`
  applied only 0084 after immutable predecessor 0083; result `COMMIT`, exit `0`.
  No manual SQL mutation or manual data repair was used.
- Final PLAN run `8ac1b68d-5800-4c18-b8f4-b22773943e4a` recorded `PLANNED`,
  eligible `7`, `READY` facts `7`, input-required `0`, and blocked `0`.
- Final EXECUTE run `b139c49f-3bd0-48c2-87e2-9c08992be6b6` recorded
  `COMPLETED`, `7` project facts in `V2_ACTIVE`, and `completed=true`.
- Final read-only VERIFY run `80f11cac-89cb-4d70-bc04-b7c3ed35c4a5`
  recorded `COMPLETED`: eligible `7`, project contracts `7 x V2_ACTIVE`,
  valid V2 active `7`, active V1 projects/generations `0`,
  `MIGRATION_BLOCKED=0`, and active refill/job/outbox/claim/provider
  request/reservation/lease counts all `0`.
- Product evidence contains `88/88` valid controlled `legacy_imported`
  lineages. All `88` use distinct candidate and visibility qualification
  facts, compatibility qualification matches candidate qualification, and no
  visibility fact is missing. Native V2 rows with missing required six IDs:
  `0`.
- V1 generation history remains `13` rows with unchanged fingerprint
  `6b7548a726753ab74efba39abedbe995`.
- Worker PID `49188` remained the same process with start time
  `2026-08-27T23:01:41.8420750+08:00`. `NtResumeProcess` returned `0`,
  suspended threads changed `28 -> 0`, and exactly one matching worker
  remained. The initial bounded 8-second read-only recheck was clean, but a
  later read-only audit superseded it: after the final VERIFY timestamp, this
  Worker created `134` V1 jobs, `134` V1 refills, and `134` V1 outbox rows.
  Provider requests/reservations/leases remained `0`, and V1 generation
  history remained `13` with the unchanged fingerprint.
- The same PID was immediately re-suspended. `NtSuspendProcess` returned `0`,
  suspended threads changed `0 -> 28`, and exactly one matching Worker
  remained. Current active refill/job/outbox/claim/provider
  request/reservation/lease counts returned to `0`, but the immutable
  post-VERIFY rows prove that the required no-new-V1-write condition failed.
- A bounded read-only stability check at `2026-09-01T08:18:00Z` and
  `2026-09-01T08:18:13Z` returned identical counts: each affected project
  retained `67` post-VERIFY jobs, refills, and outbox rows, with no active side
  effects. The suspended process produced no additional rows during the check.
- Both affected policies remain on V1 generation `3` in `building` state while
  their project contracts point to V2 generation `4`. Their pause and
  termination reasons are null, and attempted-tier entries reached `48604` and
  `48656`; the stale runtime therefore has no loaded natural termination or
  contract-aware stop condition.
- Root cause is a stale loaded runtime. PID `49188` is executing
  `backend/core/dist/modules/backlinks/runtime/production-runtime.js`, written
  `2026-08-27T21:54:41.8691837+08:00`, SHA-256
  `d1c2892612f0e408bb980d4ad00f13c9acbee6cb70524450503d05531a76c8d0`,
  which does not contain the V2 contract guard. The current guarded source was
  written on `2026-08-31` and cannot be loaded into the already-running process
  without changing the Worker PID.
- Production static scans for the authorized Phase 8 implementation remain:
  Provider/Workflow external call edges `0`; Phase 9 production call edges
  `0`. Real paid Provider/AI/Browser/Gmail calls, candidate fabrication,
  commit, push, deploy, and Phase 9 execution were all `0`.
- Under the authorization in effect for that run, restarting or replacing the
  Worker was prohibited, so Phase 8 remained blocked at the post-resume gate.
  That authorization blocker is superseded by the explicitly authorized
  guarded Worker replacement evidence below. The historical failure facts are
  retained unchanged.

### Phase 8 Guarded Worker Replacement - 2026-09-01

Task ID:
`BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-8-GUARDED-WORKER-REPLACEMENT-001`

- Checkpoint 1 reconfirmed repository
  `C:\Users\DELL\Documents\缝合\john3947-seo-main`, remote
  `https://github.com/john3947/seo.git`, branch `main`, and HEAD
  `7df8d48d088328bd79fb0a1afef364b17cc8b6af`. All pre-existing dirty paths
  remained user-owned and were preserved.
- The old Worker was PID `49188`, started
  `2026-08-27T23:01:41.8420750+08:00`, executable
  `C:\Program Files\nodejs\node.exe`, command line
  `"C:\Program Files\nodejs\node.exe" dist/index.js worker`, with `28/28`
  threads suspended. Its loaded production runtime SHA-256 was
  `D1C2892612F0E408BB980D4AD00F13C9ACBEE6CB70524450503D05531A76C8D0`.
- Focused guarded-runtime command passed with exit `0`: `11/11` files and
  `111/111` tests. It covered the V2 contract guard, production runtime,
  outbox/refill/recovery, reservation/failure, historical reassessment, and
  the refill Workflow integration. `npm run typecheck` and `npm run build`
  both passed with exit `0`.
- `npm exec -- tsx scripts/local-product-build-identity.ts check` passed with
  exit `0`. The guarded build ID is
  `local-product-8f63fdcc0178b51938527985`, source fingerprint
  `8f63fdcc0178b5193852798598ec5733ddf86395bec3324eac84bf0e672bd459`,
  and artifact fingerprint
  `fcbf023057abfd3fd0b0ede302e37e9c4b9a144f3b51fa2c37e4df700a6d21c6`.
  The new production runtime SHA-256 is
  `473518AFC281096A777CBF585165BAA97B5F9DF5C17E94433F657AC95BF54910`;
  it differs from the old hash and contains `contract_not_applicable` and
  `recommendation-pool.v2`.
- Immediately before termination, PID `49188` again matched the recorded start
  time, executable, command line, and suspended state. The command
  `Stop-Process -Id 49188 -Force` exited `0`; the process was not resumed first
  and no other service was stopped.
- The existing local-product launcher semantics imported the Compose
  configuration, preserved the local tenant identity, imported
  `C:\Users\DELL\AppData\Local\GrowthOS\live001\backlinks-worker.env` without
  printing secret values, and started exactly one hidden replacement with
  `C:\Program Files\nodejs\node.exe`, working directory `backend/core`, and
  arguments `dist/index.js worker`. The one-use launcher was removed after
  startup.
- The replacement is PID `57924`, started
  `2026-09-01T17:03:45.4176640+08:00`, with the expected executable and command
  line. PID `49188` is absent; the matching Worker count is `1`; PID `57924`
  owns health port `7302`. Health reports `status=ok`,
  `postgresReady=true`, `temporalReady=true`,
  `businessConsumersRunning=true`, and the current guarded build ID. Temporal
  reports Worker state `RUNNING` on task queue `growthos.backlinks.v1`.
- Two complete periodic/recovery scan observations at
  `2026-09-01T09:05:44.634Z` and `2026-09-01T09:05:51.421Z`, followed by the
  bounded final snapshot at `2026-09-01T09:13:43.855789Z`, returned identical
  results. Since replacement startup, V1 job/refill/outbox deltas are `0`;
  claim/provider request/reservation/lease deltas are `0`; the retained
  historical job/refill/outbox totals remain `134/134/134`.
- Final read-only
  `backlinks.backlink_recommendation_pool_v2_verify_cutover()` returned
  `completed=true`: eligible `7`, V2 active `7`, valid V2 active `7`, active V1
  projects/generations/refills/jobs/outbox/claims/provider
  requests/reservations/leases all `0`, invalid V2 active `0`, and
  `MIGRATION_BLOCKED=0`. V1 generation history remains `13`.
- New guarded service/workflow hunks contain `5` contract-guard additions,
  new external Provider invocation edges `0`, and new Phase 9 production call
  edges `0`. Replacement stdout/stderr contain Provider-request or Phase 9
  runtime markers `0`; the database Provider ledgers also have delta `0`.
- Scoped `git diff --check` passed with exit `0`. The added replacement
  evidence section is Prettier-clean when checked in isolation; the whole
  pre-existing evidence file check exited `1`, so no whole-file formatting was
  applied under the dirty-worktree preservation rule.
- Migration 0084 was not rewritten or reapplied. No 0085, manual SQL mutation,
  data repair/deletion, Provider call, Phase 9 execution, commit, push, deploy,
  clean, reset, checkout, rollback, or replacement Worker duplication occurred.

## Phase 9 - Full Switch and Regression

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-9-001`

Owned scope: disable V1 writes, retain V1 read-only history, full fake-provider
downstream regression, local runtime verification, and final evidence.

Database boundary: immutable V1 write guard and V2 maintenance/read-only rollback
state; no destructive migration.

Provider/AI/Browser ceiling: `0`; local fixture-backed Playwright is allowed.

Exit criterion:

- active V1 generation/job/outbox/reservation is zero
- new V1 recommendation/refill/provider writes are zero
- all recommendation UI/API reads use V2
- V1 historical facts are read-only
- fake-provider V2 item through Reports chain passes
- desktop/mobile local product path passes

Current phase result: `PASS_READY_FOR_SUPERVISOR_REVIEW`

### Phase 9 Final Execution Evidence - 2026-09-02

- Repository identity remained `main` at baseline HEAD
  `7df8d48d088328bd79fb0a1afef364b17cc8b6af`, remote
  `https://github.com/john3947/seo.git`. All pre-existing dirty changes were
  retained. Ownership ledger result:
  `PRE_EXISTING_USER_OWNED=preserved`,
  `W5/W6_PHASE9_OWNED=0085_and_surgical_runtime_UI_test_hunks`,
  `PRIOR_SIDE_EFFECT=134_historical_V1_rows_and_shared_Gmail_startup_refresh`,
  `DEFERRED_INERT=0080_reference_and_Phase10`,
  `OWNERSHIP_CONFLICT=0`.
- Forward-only migration
  `0085_backlink_recommendation_pool_v2_phase9_v1_freeze.sql` has SHA-256
  `f6a6b9faae93568791d1697b5ab6df5ee47e358bb186cbf17ea7db249a293e46`.
  The deployment manifest head is `backlinks-0085`; the checker reported
  `77 files through 0085`. Disposable PostgreSQL passed fresh-through-0085,
  0084-to-0085 upgrade, actual runner idempotency, privileges, `search_path`,
  RLS, concurrency, malformed/generic-lineage bypass, immutable V1 history,
  V2 noninterference, and canonical downstream allowlist tests.
- The standard, manifest/hash-bound repository migration runner applied 0085
  to the current local product database and verified its marker:
  `{"migrationId":"backlinks-0085","prerequisite":"backlinks-0084","applied":true,"verified":true}`.
  No manual SQL or product-data repair was used.
- Local product Phase 9 runs:
  PLAN `8beed448-752e-4167-b8ac-049da5b7fbb1`;
  EXECUTE `3a9fff92-0d0b-41fe-9be6-4b4bfa7e5353`;
  initial VERIFY `2e59a40a-7289-47ee-83ce-9293af905512`;
  final read-only VERIFY `bd8c87a0-8600-4c22-9eb7-f8e46eb59ad4`.
  EXECUTE and both VERIFY runs completed with `v1WritesFrozen=true`.
- Final VERIFY returned `completed=true`: eligible projects `7`, `V2_ACTIVE`
  `7`, valid V2 active `7`, invalid V2 active `0`, active V1
  projects/generations/refills/jobs/outbox/claims/provider
  requests/reservations/leases all `0`, `MIGRATION_BLOCKED=0`, V1 generation
  history `13`, and installed freeze triggers `18/18`.
- The current Worker is the sole process and sole port `7302` listener:
  PID `3812`, started `2026-09-02 03:31:49 +08:00`, command
  `"C:\Program Files\nodejs\node.exe" dist/index.js worker`, build ID
  `local-product-9bd5b7f635e945dcd6e9034e`. Health confirmed
  `postgresReady=true`, `temporalReady=true`, and
  `businessConsumersRunning=true`. The built `dist/index.js` SHA-256 is
  `B86A0EB72C36A56DDE368D8C3F0130E66A628C8511B06D8FFBA1998CC7C5FBB5`.
- The bounded runtime observation ran from
  `2026-09-02 03:34:03 +08:00` through
  `2026-09-02 03:39:31 +08:00` (`5m27s`) with an intermediate sample.
  PID, listener count, build ID, health, stdout/stderr lengths, hashes, and
  mtimes remained stable. Post-baseline V1 recommendation/refill/job/outbox/
  claim/provider-request/reservation/lease deltas were all `0`; real Phase 9
  Provider/Workflow external-call delta was `0`.
- One shared Worker Gmail token-health refresh occurred before the observation
  baseline, during replacement startup. It is recorded as
  `UNRELATED_SHARED_RUNTIME_AUDIT`, has no Phase 9 recommendation-pool causal
  edge, and is not counted as a Phase 9 Provider call. Post-baseline
  Gmail/OAuth/Provider event delta was `0`.
- Backend gates passed: disposable migration/cutover/canonical chain `5/5`;
  Phase 8 focused regression `111/111`; Phase 8 plus V1 activity guard
  `120/120`; Phase 9 backend API/read-path `76/76`; Phase 9 CLI source
  contracts `4/4`; no-email fail-closed Opportunity/Draft/Send regression
  `12/12`; Core typecheck, build identity, OpenAPI, generated-client, ESLint,
  and scoped diff checks exited `0`. The earlier undetailed Prettier claim is
  superseded by the reproducible recovery evidence below.
- Frontend gates passed: static contracts `8/8`, Playwright desktop `10/10`,
  mobile `2/2`, keyboard accessibility `1/1`, plus frontend typecheck, build,
  V2 generated-client drift, scoped Prettier, ESLint, and diff checks at exit
  `0`. All recommendation primary navigation/read paths use the V2 released
  feed; V1 history remains read-only and is not a project primary path.
- Fixture/fake-provider canonical regression proved V2 recommendation to the
  existing Opportunity, Draft, Send, Reply, Placement, and Reports chain.
  Missing-email candidates can create `contact_review_required`, while Draft
  and Send remain fail-closed. No parallel downstream system was created.
- Real DataForSEO, AI, Browser, Gmail send/sync, and Phase 9 provider calls:
  `0`. No Phase 10 implementation, physical V1 deletion, commit, push, deploy,
  or human UAT was performed.

### Phase 9 Prettier Evidence Recovery - 2026-09-02

- Recovery completed at `2026-09-02 09:46:18 +08:00` without production,
  migration, database, or runtime changes. The only format-owned files were
  `recommendation-pool-v2-phase9-canonical-chain.test.ts` and
  `deployment-manifest.v1.json`; `OWNERSHIP_CONFLICT=0`.
- Canonical-chain test SHA-256 changed from
  `383A14FF77EF2F4953A7D555BB26F970FE781840D8F82211EA548ED7428C124C`
  to `CC86C0A5C37A6EAB37A0071908102E7EA99FD8710FA9F98563ABEEEAC48100C7`.
  Prettier `--debug-check` exited `0`; the before/after TypeScript semantic AST
  fingerprint remained
  `07F80D915856430A80F91F013633DF24B76618CB9CD57591436A623D754CA6D5`.
- Deployment manifest SHA-256 changed from
  `A8C0A287DC3FA85242A44DF0C8DAA5F0680AA22FA103E5E571E349C7DFCE2E3A`
  to `63BFCBB3C0069501A5015F1D5271BC56105551F40C7B1A09969CCF6C2484C59A`.
  Parsed JSON was exactly equal before and after. Head `0085`, step
  `backlinks-0085`, prerequisite `backlinks-0084`, `forward-only` recovery,
  and migration SHA-256
  `f6a6b9faae93568791d1697b5ab6df5ee47e358bb186cbf17ea7db249a293e46`
  remained unchanged.
- Reformatting the two repository-external backups reproduced the current
  files byte-for-byte. The required two-file `prettier --check` exited `0`.
  Hunk review covered `24` TypeScript and `256` manifest formatting hunks.
- `npm run migration:backlinks:check` exited `0`: `77 files through 0085`.
  Phase 9 core tests passed `4/4` files and `14/14` tests. The final
  route/database regression passed `8/8` files and `22/22` tests. An earlier
  default-timeout run and a pre-existing randomized cursor-tamper no-op were
  retained as failure evidence; no test or production file was changed to
  obtain the final pass.
- Core and frontend typecheck, scoped backend and frontend ESLint, Backlinks
  OpenAPI (`90` paths), generated Backlinks client (`92` operations), local
  product build identity, and scoped `git diff --check` all exited `0`.
- Read-only runtime identity remained one Worker and one port `7302` listener:
  PID `3812`, build ID `local-product-9bd5b7f635e945dcd6e9034e`, health
  `status=ok`, `postgresReady=true`, `temporalReady=true`, and
  `businessConsumersRunning=true`. No Worker, service, or container was
  stopped, started, or restarted.
- Phase 10 production call-edge scan returned `0`. No new Provider, Workflow,
  Gmail, OAuth, or product-database operation was introduced or invoked:
  `PHASE_10_ENTERED=false`, `REAL_PROVIDER=NOT_RUN_ZERO_CALLS`,
  `DEPLOYMENT=NOT_RUN`, and `HUMAN_UAT=NOT_RUN`.

## Final Evidence Layers

- IMPLEMENTED: `PASS_THROUGH_PHASE_9_FULL_SWITCH`
- TESTED: `PASS_PHASE_9_MIGRATION_RUNTIME_API_UI_AND_CANONICAL_CHAIN`
- LOCAL_RUNTIME: `PASS_PHASE_9_FROZEN_V1_WRITES_AND_ZERO_SIDE_EFFECT_DELTA`
- REAL_PROVIDER: `NOT_RUN_ZERO_CALLS`
- SAMPLE_ACCEPTANCE: `PASS_PHASE_9_VERIFY_7_OF_7`
- DEPLOYMENT: `NOT_RUN`
- HUMAN_UAT: `NOT_RUN`

## Phase 1 Initial Execution Evidence - 2026-08-29 (Superseded)

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-1-001`

Result: `BLOCKED`

The owned Phase 1 implementation and focused tests pass. The phase cannot report
`PASS` because V2 API, runtime, Workflow registration, OpenAPI, Generated Client,
and frontend wiring remain active in 21 ownership-conflict paths. Those files were
dirty before the V2 implementation task and were later modified or generated by w5,
so there is no safe pre-w5 version that this phase may restore without overwriting
shared work.

### Git and Dirty Ledger

- Start and end Git root:
  `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Remote: `origin https://github.com/john3947/seo.git`
- Branch: `main`
- Start and end HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Original full-task dirty baseline: `71 tracked + 9 untracked = 80`
- Phase 1 start and end dirty state:
  `103 tracked + 64 untracked = 167`, `0 unmerged`
- Ownership ledger:
  `PRE_EXISTING_USER_OWNED=59`, `W5_PHASE1_OWNED=12`,
  `W5_OUT_OF_PHASE_SIDE_EFFECT=75`, `OWNERSHIP_CONFLICT=21`
- No pre-existing or ownership-conflict path was reverted, overwritten, cleaned, or
  formatted.

### Phase 1 Changed Files

- `backend/core/src/modules/backlinks/db/migrations/0080_backlink_recommendation_pool_v2.sql`
- `backend/database/deployment-manifest.v1.json` (0080 head and hash only)
- `backend/core/src/modules/backlinks/domain/recommendations/recommendation-batch-policy.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/recommendation-marker-policy.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/recommendation-pool-v2-policy.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/recommendation-user-unlock-policy.ts`
- `backend/core/test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts`
- `backend/core/test/unit/recommendation-batch-policy.test.ts`
- `backend/core/test/unit/recommendation-marker-policy.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-policy.test.ts`
- `backend/core/test/unit/recommendation-user-unlock-policy.test.ts`
- `docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md`

The executable 0080 migration is additive and represents seed, batch, publication,
cursor, unlock, action, generation-contract, scope/context lineage, RLS, immutable,
and idempotency facts. Executable Phase 8/9 cutover tables/functions, V1 freeze
triggers, and visibility-switch policies were removed from the active SQL. The
remaining commented cutover text is `DEFERRED_INERT` and has no migration effect.
The 0080 SHA-256 recorded by the manifest is
`4e4c57247b72e554dbdbe6f3794b710d6dd6a097aef0e35837dad7b089086d24`.

### Ownership Conflicts

The following 21 paths are `OWNERSHIP_CONFLICT` and were kept read-only:

```text
backend/core/src/modules/backlinks/api/recommendation-commands.route.ts
backend/core/src/modules/backlinks/application/commands/recommendations.command.ts
backend/core/src/modules/backlinks/application/services/commercial-inventory-refill.service.ts
backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts
backend/core/src/modules/backlinks/application/services/current-commercial-static-assessment-recovery.service.ts
backend/core/src/modules/backlinks/runtime/production-runtime.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts
backend/core/test/backlinks/api/recommendation-commands-route.test.ts
backend/core/test/backlinks/integration/recommendation-refill-workflow.test.ts
backend/core/test/unit/commercial-inventory-refill.test.ts
backend/core/test/unit/commercial-recommendation-discovery.service.test.ts
backend/core/test/unit/production-runtime.test.ts
backend/core/test/unit/recommendations-command.test.ts
docs/architecture/backlinks-recommendation-pool-v2-compatibility-and-coding-plan.md
frontend/src/features/outreach/recommendations/promotion-target-setup.test.tsx
frontend/src/features/outreach/recommendations/promotion-target-setup.tsx
frontend/src/features/outreach/recommendations/recommendations-source.test.mjs
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
backend/contracts/openapi/backlinks.v1.json
backend/contracts/openapi/platform.v1.json
frontend/src/api/generated/backlinks.ts
```

Static evidence shows active V2 feed route registration in `private-server.ts`,
V2 services and activities in `production-runtime.ts`, V2 Workflow namespaces and
definition exports, six recommendation-feed OpenAPI routes, matching Generated
Client operations, and V2 feed hooks in `recommendations-workspace.tsx`. Removing
the 75 w5-exclusive later-phase files would therefore break imports and typecheck;
removing the references would require editing the shared conflict paths. The
side-effect set is preserved, not treated as inert, and is the reason for
`BLOCKED`.

The 75 `W5_OUT_OF_PHASE_SIDE_EFFECT` paths comprise 31 tracked and 44 untracked
paths:

```text
backend/api/tests/test_shared_contracts.py
backend/core/scripts/check-backlinks-openapi.ts
backend/core/src/modules/backlinks/api/opportunity-commands.route.ts
backend/core/src/modules/backlinks/api/private-server.ts
backend/core/src/modules/backlinks/application/commands/opportunities.command.ts
backend/core/src/modules/backlinks/application/repositories/draft-generation.repository.ts
backend/core/src/modules/backlinks/application/services/current-commercial-static-assessment-recovery-scheduler.service.ts
backend/core/src/modules/backlinks/application/services/historical-commercial-reassessment.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-reservation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-supersession.service.ts
backend/core/src/modules/backlinks/db/repositories/opportunity.repository.ts
backend/core/src/modules/backlinks/db/repositories/outbox.repository.ts
backend/core/src/modules/backlinks/db/repositories/recommendation-contract.repository.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts
backend/core/src/modules/backlinks/workflows/definitions/index.ts
backend/core/src/modules/backlinks/workflows/namespaces.ts
backend/core/src/modules/backlinks/workflows/outbox-relay.ts
backend/core/test/backlinks/api/opportunity-transitions-route.test.ts
backend/core/test/backlinks/api/private-server.test.ts
backend/core/test/backlinks/integration/commercial-discovery-batch-takeover.test.ts
backend/core/test/backlinks/integration/outbox-relay.test.ts
backend/core/test/backlinks/integration/recommendation-refill-supersession.test.ts
backend/core/test/unit/backlinks-openapi.test.ts
backend/core/test/unit/current-commercial-static-assessment-recovery-scheduler.service.test.ts
backend/core/test/unit/current-commercial-static-assessment-recovery.service.test.ts
backend/core/test/unit/recommendation-contract.repository.test.ts
backend/core/test/unit/recommendation-refill-reconciliation.test.ts
backend/core/test/unit/recommendation-refill-reservation.test.ts
frontend/scripts/generate-backlinks-client.mjs
frontend/src/features/outreach/api/project-query.ts
backend/core/src/modules/backlinks/activities/recommendation-pool-v2.activity.ts
backend/core/src/modules/backlinks/api/recommendation-feed.route.ts
backend/core/src/modules/backlinks/application/commands/recommendation-feed.command.ts
backend/core/src/modules/backlinks/application/queries/recommendation-feed.query.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-contact-preparation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-cutover.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-generation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-release-snapshot.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-workflow.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-release-batch.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-seed-preparation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-user-release.service.ts
backend/core/src/modules/backlinks/db/repositories/recommendation-feed.repository.ts
backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2-cutover.repository.ts
backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts
backend/core/src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-pool-v2.workflow.ts
backend/core/src/modules/backlinks/workflows/recommendation-pool-v2.starter.ts
backend/core/test/backlinks/api/recommendation-feed-route.test.ts
backend/core/test/backlinks/integration/opportunity-create-from-recommendation-feed-item.test.ts
backend/core/test/backlinks/integration/recommendation-pool-v2-cutover.integration.test.ts
backend/core/test/backlinks/integration/recommendation-pool-v2-phase9-canonical-chain.test.ts
backend/core/test/backlinks/unit/
backend/core/test/unit/historical-commercial-reassessment-contract-guard.test.ts
backend/core/test/unit/opportunities-command-v2.test.ts
backend/core/test/unit/outbox-repository.test.ts
backend/core/test/unit/recommendation-pool-contract-guard.test.ts
backend/core/test/unit/recommendation-pool-v2-application-services.test.ts
backend/core/test/unit/recommendation-pool-v2-contact-preparation.test.ts
backend/core/test/unit/recommendation-pool-v2-generation.service.test.ts
backend/core/test/unit/recommendation-pool-v2-starter.test.ts
backend/core/test/unit/recommendation-pool-v2-temporal-registration.test.ts
backend/core/test/unit/recommendation-pool-v2-workflow.test.ts
backend/core/test/unit/recommendation-refill-outbox-consumer.test.ts
backend/core/test/unit/recommendation-refill-supersession-contract-guard.test.ts
frontend/src/api/generated/backlinks-v2-contract.test.ts
frontend/src/features/outreach/api/project-query.test.ts
frontend/src/features/outreach/recommendations/recommendation-feed-api.ts
frontend/src/features/outreach/recommendations/recommendation-feed-cache.test.ts
frontend/src/features/outreach/recommendations/recommendation-feed-cache.ts
frontend/src/features/outreach/recommendations/recommendation-feed-state.test.ts
frontend/src/features/outreach/recommendations/recommendation-feed-state.ts
frontend/src/features/outreach/recommendations/use-recommendation-feed.ts
```

### Verification

- `npm run migration:backlinks:check`: `PASS`, 72 migration files through 0080.
- `npx vitest run test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts`:
  `PASS`, 1 file and 2 tests. The disposable PostgreSQL harness verifies both a
  fresh sequence through 0079 plus explicit 0080 and the 0079-to-0080 upgrade,
  including Schema, RLS, FK, immutability, idempotency, and absence of cutover/V1
  freeze objects.
- `npx vitest run test/unit/recommendation-pool-v2-policy.test.ts test/unit/recommendation-batch-policy.test.ts test/unit/recommendation-marker-policy.test.ts test/unit/recommendation-user-unlock-policy.test.ts`:
  `PASS`, 4 files and 24 tests.
- `npm run typecheck` in `backend/core`: `PASS`.
- Focused V1/runtime/refill fixture regression:
  `PASS`, 6 files and 116 tests.
- `npm run openapi:backlinks:check`: `PASS`, 89 paths; focused OpenAPI tests:
  `PASS`, 1 file and 5 tests.
- `npm run check:backlinks-client`: `PASS`, 91 generated operations; frontend
  `npm run typecheck`: `PASS`; recommendation source tests: `PASS`, 3 tests.
- Owned-file Prettier check: `PASS`.

All migration execution occurred only inside the disposable test database. No
migration was applied to the local product database. No build, service start/stop,
Temporal/Worker operation, manual database write, candidate fabrication, commit,
push, or deployment was performed.

### Cost and Remaining Impact

- Provider/AI/Browser/DataForSEO/Gmail calls: `0`
- Provider cost: `0`
- Local product database writes: `0`
- Service/process mutations: `0`
- Commit/push/deploy: `0`
- Residual current-project impact: the dirty checkout compiles and focused tests
  pass, but active later-phase V2 wiring remains present and is not a valid
  Phase 1-only state.
- Residual Phase 2-9 impact: later phases cannot start from a clean serial boundary
  until the 21 ownership conflicts receive an explicit owner/resolution decision.
- Phase 2 was not entered. Phase 2-9 implementation and runtime acceptance were not
  executed.

## Phase 1 Recovery Run Evidence - 2026-08-29

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-1-001`

Result: `PASS`

The prior Phase 2 `PASS` claim was withdrawn after supervisor review found that
the seed routes were not registered in the product API and the pre-task command
was not invoked before the existing discovery readiness gate. The repository,
service, command, route, and focused tests remain partial Phase 2 artifacts
until that minimum production composition and gate ordering are implemented and
verified.

This recovery run supersedes the ownership-conflict result above. It restored the
checkout to a Phase 1-only activation boundary without changing the original user
baseline, completed every Phase 1 verification gate, and did not enter Phase 2.
The Phase 0 result remains `PASS`.

### Recovery Checkpoint A

- Git root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Remote: `origin https://github.com/john3947/seo.git`
- Branch: `main`
- Start and end HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Original full-task dirty baseline: `71 tracked + 9 untracked = 80`
- Recovery start dirty state: `103 tracked + 70 untracked = 173`,
  `0 unmerged`
- Recovery end status view: `99 tracked status entries + 68 untracked = 167`,
  `0 unmerged`. Git's Windows line-ending conversion reports phantom tracked
  status entries; the content-level `git diff --name-only` result is `72`.
- Content-level tracked result: the original `71` baseline tracked paths plus only
  the Phase 1-owned deployment manifest. No additional w5 tracked later-phase diff
  remains.
- Backlinks migration head: `0080`
- Manifest entry: order `271`, prerequisite `backlinks-0079`
- 0080 SHA-256:
  `4e4c57247b72e554dbdbe6f3794b710d6dd6a097aef0e35837dad7b089086d24`

### Recovery Ownership Ledger

- `PRE_EXISTING_USER_OWNED=59`: retained at the exact task-start content boundary.
- `W5_PHASE1_OWNED=12`: the 0080 migration, its manifest entry, four pure policies,
  five focused tests, and this execution evidence.
- `OWNERSHIP_CONFLICT=0`: all 21 paths listed in the superseded evidence now have
  a verified non-overwriting resolution.
- The 13 shared backend/runtime/test paths were restored by reversing only recorded
  w5 hunks. Their pre-existing user hunks remain.
- The four shared recommendation frontend paths were restored from complete
  pre-w5 byte snapshots or exact recorded patch reversal.
- The two OpenAPI contracts and Generated Client were regenerated from the restored
  tracked backend with the repository's official generators.
- The compatibility/coding plan remained user-owned and read-only.
- The original 75-path `W5_OUT_OF_PHASE_SIDE_EFFECT` set resolved as:
  `31 REPAIRED_TRACKED`, `2 REPAIRED_DELETED`, and
  `42 DEFERRED_INERT`.
- Six additional unique Phase 2 paths created during the delayed Phase 2 run are
  also `W5_OUT_OF_PHASE_SIDE_EFFECT / DEFERRED_INERT`. Including the previously
  existing seed-preparation service, the seven Phase 2 files reviewed were:

```text
backend/core/src/modules/backlinks/api/recommendation-seeds.route.ts
backend/core/src/modules/backlinks/application/commands/recommendation-seeds.command.ts
backend/core/src/modules/backlinks/application/services/recommendation-seed-preparation.service.ts
backend/core/src/modules/backlinks/db/repositories/recommendation-seed.repository.ts
backend/core/test/backlinks/api/recommendation-seeds-route.test.ts
backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts
backend/core/test/unit/recommendation-seed-preparation-phase2.test.ts
```

These seven files remain untracked, are absent from tracked API registration,
Workflow exports, runtime composition, OpenAPI, Generated Client, and frontend
imports, and do not break Core typecheck. The known Phase 2 ESLint error for the
unused `ValidateInput` symbol was not changed because Phase 2 is outside this run.

The two future files below were w5-exclusive, untracked, referenced removed
later-phase contracts, and broke Core typecheck. They were removed as the minimum
required Phase 1 recovery:

```text
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-pool-v2.workflow.ts
backend/core/src/modules/backlinks/workflows/recommendation-pool-v2.starter.ts
```

The final later-phase side-effect result is therefore:
`33 REPAIRED` and `48 DEFERRED_INERT`, with `OWNERSHIP_CONFLICT=0`.
Tracked static searches found no seed/V2 recommendation-pool API, Workflow,
runtime, Generated Client, or frontend activation.

### Phase 1 Owned Files

```text
backend/core/src/modules/backlinks/db/migrations/0080_backlink_recommendation_pool_v2.sql
backend/database/deployment-manifest.v1.json
backend/core/src/modules/backlinks/domain/recommendations/recommendation-batch-policy.ts
backend/core/src/modules/backlinks/domain/recommendations/recommendation-marker-policy.ts
backend/core/src/modules/backlinks/domain/recommendations/recommendation-pool-v2-policy.ts
backend/core/src/modules/backlinks/domain/recommendations/recommendation-user-unlock-policy.ts
backend/core/test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts
backend/core/test/unit/recommendation-batch-policy.test.ts
backend/core/test/unit/recommendation-marker-policy.test.ts
backend/core/test/unit/recommendation-pool-v2-policy.test.ts
backend/core/test/unit/recommendation-user-unlock-policy.test.ts
docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md
```

### Recovery Verification

- `npm run migration:backlinks:check`: exit `0`; `72` migration files through
  `0080`.
- Disposable PostgreSQL fresh-through-0080 and 0079-to-0080 upgrade:
  `npx vitest run test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts --reporter=verbose`;
  exit `0`, `1/1` file and `2/2` tests. The empty disposable database applied the
  full manifest through 0079, asserted that V2 relations were absent, then applied 0080. The assertions cover Schema, RLS, compound scope/lineage FKs,
  immutability, idempotency, and absence of executable cutover/V1-freeze objects.
- Pure Domain Policy:
  `npx vitest run test/unit/recommendation-pool-v2-policy.test.ts test/unit/recommendation-batch-policy.test.ts test/unit/recommendation-marker-policy.test.ts test/unit/recommendation-user-unlock-policy.test.ts --reporter=verbose`;
  exit `0`, `4/4` files and `24/24` tests.
- `npm run typecheck` in `backend/core`: final exit `0`. The first recovery run
  identified the two untracked future Workflow files above; after their scoped
  removal, typecheck passed.
- Phase 1-owned ESLint: exit `0`, no findings.
- Phase 1-owned Prettier check: exit `0`, all matched files use repository style.
- `git diff --check`: exit `0`; Windows line-ending notices only, no whitespace
  errors.
- `npm run openapi:backlinks:check`: exit `0`, `81` paths.
- Shared contract checker:
  `backend/api/.venv/Scripts/python.exe backend/api/scripts/check_shared_contracts.py`;
  exit `0`, `243` public paths, `273` operations.
- `npm run check:backlinks-client`: exit `0`, `83` generated operations.
- Focused OpenAPI tests: exit `0`, `1/1` file and `4/4` tests.
- V1/runtime/refill/API visibility regression:
  `npx vitest run test/backlinks/api/recommendation-commands-route.test.ts test/backlinks/integration/recommendation-refill-workflow.test.ts test/unit/commercial-inventory-refill.test.ts test/unit/commercial-recommendation-discovery.service.test.ts test/unit/production-runtime.test.ts test/unit/recommendations-command.test.ts --reporter=verbose`;
  final exit `0`, `6/6` files and `105/105` tests. The first run exposed a CRLF
  byte-level restoration artifact in `production-runtime.ts`; restoring only that
  file's original LF representation fixed the source-string assertion without
  changing code or tests.
- Recommendation source regression:
  `node --test src/features/outreach/recommendations/recommendations-source.test.mjs`;
  exit `0`, `3/3` tests.
- Promotion setup regression:
  `npx vitest run src/features/outreach/recommendations/promotion-target-setup.test.tsx --reporter=verbose`;
  exit `0`, `1/1` file and `3/3` tests.
- Tracked activation search for seed/V2 recommendation-pool API, runtime,
  Workflow, Generated Client, and frontend symbols: no matches.

Two preliminary generator invocations used an interpreter without FastAPI and the
repository root instead of the frontend package, respectively. Both failed before
writing output. The corrected official generator commands succeeded and their
read-only checks pass.

All database migration verification used disposable test databases only. The local
product database was not modified.

### Phase 1 Exit Criteria

- Additive V2 facts, scope, tenant, lineage, immutability, and idempotency:
  `PASS`
- Fresh migration through 0080 and 0079-to-0080 upgrade: `PASS`
- Pure Domain Policy tests: `PASS`
- `OWNERSHIP_CONFLICT=0`: `PASS`
- All w5 later-phase side effects are `REPAIRED` or evidence-backed
  `DEFERRED_INERT`: `PASS`
- No API, Workflow, runtime, frontend, Generated Client, or V1 visibility switch:
  `PASS`
- Provider/AI/Browser/DataForSEO/Gmail calls: `0`
- Provider cost: `0`
- Local product database writes: `0`
- Service start/stop and Temporal/Worker business operations: `0`
- Candidate fabrication: `0`
- Commit/push/deploy: `0`

### Result Layers

- IMPLEMENTED: `PHASE_1_IMPLEMENTED`
- TESTED: `PHASE_1_RECOVERY_PASS`
- LOCAL_RUNTIME: `NOT_RUN_PHASE_1_BOUNDARY`
- REAL_PROVIDER: `NOT_RUN_REQUIRES_AUTHORIZATION`
- SAMPLE_ACCEPTANCE: `NOT_RUN_PHASE_1_BOUNDARY`
- DEPLOYMENT: `NOT_RUN`
- HUMAN_UAT: `NOT_RUN`

At the end of that recovery run, Phase 2 remained not passed and was not continued
or repaired. No Phase 2 lint fix was made in that run. Phase 3-9 were not entered.

## Phase 2 Execution Evidence - 2026-08-29

Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-2-001`

Result: `PHASE_2_PASS_READY_FOR_SUPERVISOR_REVIEW`

The independently verified Phase 1 Recovery code/test result remains recorded as
`PASS`. The persisted-effective-set regression initially exposed a missing
append-only provenance fact. The user then authorized continuing Phase 2 B under
the requirements and coding documents. The resolution added that fact to the
unapplied additive 0080 migration, updated only its manifest hash, and reran the
Phase 1 migration gates plus all Phase 2 gates. Phase 3 was not entered.

### Phase 2 Checkpoint A

- Git root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`
- Remote: `origin https://github.com/john3947/seo.git`
- Branch: `main`
- Start and end HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Original Phase 2 start dirty state: `99 tracked status entries + 68 untracked
= 167`, `0 unmerged`.
- Wiring-correction checkpoint and final dirty state: `99 tracked status entries
  - 69 untracked = 168`, `0 unmerged`. The additional untracked path is the
    Phase 2-owned readiness-wiring test.
- Backlinks migration head: `0080`
- Manifest entry: order `271`, prerequisite `backlinks-0079`
- 0080 SHA-256:
  `4e4c57247b72e554dbdbe6f3794b710d6dd6a097aef0e35837dad7b089086d24`
- Migration and manifest content were read-only in this run.

### Phase 2 Ownership Ledger

- `PRE_EXISTING_USER_OWNED`: all dirty paths outside the Phase 2 set stayed
  read-only. In `production-runtime.ts`, the pre-existing provider-availability
  changes at the current diff hunks near lines `2483`, `2520`, and `3159` were
  not edited. In `local-product-dataforseo-runtime.ts`, the pre-existing
  performance, concurrency, scoring, refill, publication, and store hunks were
  not edited. Existing line-ending and whole-file formatting state was preserved.
- `W5_PHASE2_OWNED=8 files + isolated hunks in 3 shared files + evidence`: the
  eight seed source/test files below, the route and dependency composition in
  `private-server.ts`, command/repository composition in
  `production-runtime.ts`, the seed-readiness gate in
  `local-product-dataforseo-runtime.ts`, and this Phase 2 evidence section.
- `private-server.ts` Phase 2 hunks: current lines `21`, `89`, `148`, and
  `316-321`. The rest of the shared file was not formatted or rewritten.
- `production-runtime.ts` Phase 2 hunks: current lines `32-35`, `165`,
  `1676-1677`, `1840`, `2126-2128`, and `2152`. The unrelated
  provider-availability hunks remained byte-preserved.
- `local-product-dataforseo-runtime.ts` Phase 2 hunks: seed/context imports;
  seed eligibility, Blueprint-lineage validation, pre-task preparation, context
  merge, and readiness orchestration at current lines `20-52`, `567-987`;
  the optional seed command at `1858-1861`; contract projection/join at
  `2484-2516`; and the production orchestration call at `2529-2566`.
  Adjacent pre-existing performance and provider behavior was not changed.
- `W5_PRIOR_OUT_OF_PHASE_SIDE_EFFECT`: the Phase 1 Recovery ledger remains
  authoritative. No prior Phase 3-9 artifact was completed or activated here.
- `DEFERRED_INERT`: future recommendation feed, V2 Activity/Workflow, release,
  contact, cutover, Generated Client, and frontend artifacts remain unregistered
  and unreachable from the three shared product-wiring files.
- `OWNERSHIP_CONFLICT=0`: every Phase 2 shared-file hunk is non-overlapping and
  independently identifiable from the preserved pre-existing hunks.
- `W5_PHASE2_B_OWNED`: the provenance projection hunks in
  `recommendation-seed.repository.ts`, the A/B/C disposable PostgreSQL
  regressions, and the schema test are Phase 2 B-owned. The new append-only
  provenance assertion table in 0080 and the corresponding manifest hash are the
  explicitly authorized minimum predecessor-schema correction. No other 0080
  contract or manifest entry was changed.
- Phase 2 B did not edit the three shared product-wiring files. Their prior
  Phase 2 hunks and all preserved user-owned adjacent hunks remained unchanged.

### Phase 2 Changed Files

```text
backend/core/src/modules/backlinks/api/recommendation-seeds.route.ts
backend/core/src/modules/backlinks/application/commands/recommendation-seeds.command.ts
backend/core/src/modules/backlinks/application/services/recommendation-seed-preparation.service.ts
backend/core/src/modules/backlinks/db/migrations/0080_backlink_recommendation_pool_v2.sql
backend/core/src/modules/backlinks/db/repositories/recommendation-seed.repository.ts
backend/core/test/backlinks/api/recommendation-seeds-route.test.ts
backend/core/test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts
backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts
backend/core/test/unit/recommendation-seed-preparation-phase2.test.ts
backend/core/test/unit/recommendation-seed-readiness-wiring-phase2.test.ts
backend/core/src/modules/backlinks/api/private-server.ts
backend/core/src/modules/backlinks/runtime/production-runtime.ts
backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts
backend/database/deployment-manifest.v1.json
docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md
```

The repository's unused `ValidateInput` type import was removed. Focused tests
cover explicit supersession lineage, evidence-free fake AI exclusion,
generation-scoped fingerprints, empty-project `INPUT_REQUIRED`, cross-tenant
isolation, cross-workspace isolation, production gate ordering, fail-closed
Blueprint lineage, and V1 zero seed writes.

### Implemented Behavior

- Seed preparation reads the pinned V2 generation contract, immutable project
  context, generation input pin, and outreach profile snapshot under the supplied
  organization/workspace/project scope.
- User keywords, categories, and competitors are persisted as `USER_INPUT`,
  remain traceable, support explicit `supersedesSeedId`, and are not silently
  overwritten or physically deleted by system supplementation.
- Project keywords/products/audiences and canonical-domain evidence can form
  deterministic fallback seeds. Evidence-free fake AI candidates remain
  `PENDING`; they are not treated as verified facts.
- If no eligible evidence-backed seed exists, the result is `INPUT_REQUIRED`
  with `DISCOVERY_SEEDS_REQUIRED`; no website, keyword, competitor, or candidate
  is fabricated.
- Only `VERIFIED` and `RETAINED_LOW_CONFIDENCE` seeds are bound to the active
  Blueprint. References persist the actual seed ID and seed fingerprint.
- A V2 `READY` result fails closed unless every eligible seed has exactly one
  persisted Blueprint reference with the matching seed ID, fingerprint, unique
  record ID, one Blueprint ID, and a complete unique ordinal set. Empty,
  missing, duplicate, or mismatched references return explicit `INPUT_REQUIRED`
  before the existing readiness gate.
- The repository uses a tenant transaction, workspace/idempotency advisory lock,
  persisted idempotency record, and 0080 database uniqueness constraints.
  Concurrent equivalent requests replay the same durable response; generation
  normalized-value duplication is database-enforced.
- `generate` is registered through the private Backlinks product API using the
  production repository/command composition.
- `prepareBeforeTask` is composed into the local product runtime. The production
  `execute()` path calls `executeRecommendationSeedReadinessGate` before the
  existing generation-input readiness resolver. `INPUT_REQUIRED` prevents
  readiness, provider, discovery, and store edges; a valid `READY` result with
  complete persisted lineage reaches the pre-existing downstream edge.
- V1 contracts are treated as not applicable at the seed gate (`null`) and do
  not invoke seed preparation or create seed writes.

### Phase 2 Verification

- Phase 2 unit, route, and production-wiring tests:
  `npx vitest run test/unit/recommendation-seed-preparation-phase2.test.ts
test/unit/recommendation-seed-readiness-wiring-phase2.test.ts
test/backlinks/api/recommendation-seeds-route.test.ts --reporter=verbose`;
  exit `0`, `3/3` files and `19/19` tests. The wiring suite contributed `8/8`
  tests and proved production ordering, zero downstream calls on
  `INPUT_REQUIRED`, empty-Blueprint-reference rejection, ID/fingerprint/ordinal
  mismatch rejection, V1 zero seed writes, and the route/runtime composition.
- Disposable PostgreSQL repository integration:
  `npx vitest run test/backlinks/integration/recommendation-seed-repository.test.ts --reporter=verbose`;
  exit `0`, `1/1` file and `3/3` tests. The harness installed the manifest through
  0080 in an isolated container and covered atomic replay, normalized
  idempotency, project isolation, tenant isolation, and workspace isolation.
- Total Phase 2 focused result: `4/4` files and `22/22` tests.
- `npm run typecheck` in `backend/core`: exit `0`.
- Focused ESLint over the eight owned files and three shared wiring files:
  exit `0`, no findings.
- Focused Prettier check over the eight owned Phase 2 files: exit `0`, all
  matched files use repository style.
- The three shared files intentionally remain whole-file Prettier failures:
  working-tree exit `1`; each corresponding HEAD file also exits `1`. No
  whole-file write was performed. An in-memory comparison of every Phase 2-owned
  shared hunk against official Prettier output returned
  `W5_SHARED_HUNK_LINES_MATCH_PRETTIER_OUTPUT`.
- Scoped `git diff --check` over the shared files and evidence plus a trailing
  whitespace scan over all eight owned files: exit `0`,
  `SCOPED_DIFF_CHECK_AND_OWNED_TRAILING_WHITESPACE_PASS`.
- Existing V1/API/runtime regression:
  `npx vitest run test/backlinks/api/recommendation-commands-route.test.ts
test/unit/recommendations-command.test.ts
test/backlinks/api/private-server.test.ts
test/unit/production-runtime.test.ts
test/unit/local-product-dataforseo-runtime.test.ts --reporter=verbose`;
  exit `0`, `5/5` files and `65/65` tests. Provider behavior used fixtures/fakes.
  One existing private-server test opened and closed an ephemeral in-process
  loopback listener; no product service was started.
- Production call-graph scan: exit `0`,
  `PHASE2_PRODUCTION_CALL_GRAPH_PRESENT`, covering private route registration,
  API/worker command composition, repository composition, and the actual
  `executeRecommendationSeedReadinessGate` call from product `execute()`.
- Phase 2 source edge scan: exit `0`,
  `NO_PHASE3_PROVIDER_WORKFLOW_RUNTIME_IMPORT_OR_CALL_EDGE`.
- Shared product-wiring scan: exit `0`,
  `NO_PHASE3_TO_PHASE9_PRODUCT_REGISTRATION_IN_SHARED_WIRING`.

All PostgreSQL writes occurred only inside the disposable integration-test
container. No migration was applied to the local product database, and no manual
product SQL was executed.

### Persisted Effective-Set Regression - 2026-08-29

Supervisor review identified three missing durable semantics. Before Phase 2 B
schema authorization, the Phase 2-owned repository and disposable PostgreSQL
integration file covered the A/C effective-set behavior without changing 0080:

```text
backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts:485
backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts:532
backend/core/test/backlinks/integration/recommendation-seed-repository.test.ts:606
```

Fresh command after the repository fix:
`npx vitest run test/backlinks/integration/recommendation-seed-repository.test.ts
--reporter=verbose`; exit `1`, `1/1` file failed, `5/6` tests passed and only
the durable provenance regression failed:

- persisted USER_INPUT followed by empty `PRE_TASK_FALLBACK`: `PASS`; the
  response reuses the same persisted seed, returns `READY`, and binds the
  existing complete Blueprint seed ID/fingerprint/ordinal;
- supersession effective set: `PASS`; the repository query excludes a seed when
  a same-scope, same-generation successor has
  `successor.supersedes_seed_id=seed.id`, while both physical seed rows remain;
- immutable Blueprint assignment after supersession: `PASS_FAIL_CLOSED`; the
  historical assignment remains unchanged, the superseded seed is absent from
  returned current membership, and the response is `INPUT_REQUIRED` with
  `BLUEPRINT_SEED_REBIND_REQUIRED` rather than returning inconsistent lineage;
- SYSTEM_FALLBACK followed by the same normalized USER_INPUT: `FAILED`; the
  durable row still contains only `SYSTEM_FALLBACK` source and PROJECT_CONTEXT
  evidence.

At that checkpoint, the remaining failure was a predecessor schema blocker:

- 0080 constraint `backlink_commercial_seed_generation_value_uq` permits only one
  row for organization/workspace/project/generation/kind/normalized value;
- 0080 constraint `backlink_commercial_seed_fingerprint_uq` also permits only one
  canonical generation/kind/value fingerprint;
- trigger `backlink_commercial_seed_immutable` rejects every UPDATE or DELETE on
  `backlink_commercial_discovery_seeds`;
- Phase 2 repository `ON CONFLICT DO NOTHING` therefore cannot append a same-value
  USER_INPUT fact, and it cannot upgrade the existing fallback row without
  violating the Phase 1 immutability contract.

At that checkpoint, no independent append-only seed provenance fact table
existed. Persisting the user request only in an idempotency response, projecting
USER_INPUT in memory, altering normalized values, or fabricating a replacement
fingerprint would not satisfy durable provenance and was not used.

Focused quality checks after the repository fix:

- `npx eslint src/modules/backlinks/db/repositories/recommendation-seed.repository.ts
  test/backlinks/integration/recommendation-seed-repository.test.ts`; exit `0`;
- `npm run typecheck`; exit `0` (`tsc --noEmit`);
- no whole-file formatter was run on shared dirty files, and 0080 was not
  modified at that checkpoint.

The wider `22/22`, 11-file lint, owned Prettier, `65/65` V1/runtime regression,
and call-graph results were not rerun because the authorized recovery was limited
to A/C plus the disposable PostgreSQL regression and necessary static checks.
Their earlier results remain historical evidence and are not used to claim a
current Phase 2 PASS.

### Phase 2 Exit Criteria

- Evidence-backed fallback for valid empty-input projects: `PASS`
- Explicit `INPUT_REQUIRED` when reliable seeds cannot be formed: `PASS`
- No fabricated website, keyword, competitor, or candidate: `PASS`
- Persisted USER_INPUT reused by empty pre-task fallback: `PASS`
- User input retained, editable through explicit supersession, and traceable:
  `PASS`
- System supplementation cannot silently overwrite or erase later user
  provenance: `PASS_APPEND_ONLY_ASSERTION`
- Source and evidence provenance for a same-value later USER_INPUT:
  `PASS`
- Superseded rows physically retained but excluded from the current effective
  set and returned Blueprint membership: `PASS_FAIL_CLOSED`
- Immutable historical Blueprint assignment is never updated or deleted:
  `PASS`
- Only eligible statuses bind actual seed IDs and fingerprints to Blueprint:
  `PASS`
- Database-backed normalized deduplication, idempotency, and concurrent replay:
  `PASS`
- Tenant, workspace, and project isolation: `PASS`
- User-triggered product route registration: `PASS`
- Pre-task fallback invocation before the existing readiness gate:
  `PASS`
- Complete persisted Blueprint seed IDs, fingerprints, and ordinals required
  before readiness: `PASS`
- `INPUT_REQUIRED` blocks provider, discovery, and store edges: `PASS`
- V1 seed-write isolation: `PASS`
- Provider/AI/Browser/DataForSEO/Gmail calls: `0`
- Provider cost: `0`
- Local product database writes: `0`
- Service start/stop and Temporal/Worker business operations: `0`
- Candidate fabrication: `0`
- Commit/push/deploy: `0`

### Phase 2 Result Layers

- IMPLEMENTED: `PASS_PHASE_2`
- TESTED: `PASS_PHASE_2_FIXTURE_DISPOSABLE_POSTGRESQL`
- LOCAL_RUNTIME: `NOT_RUN_PHASE_2_BOUNDARY`
- REAL_PROVIDER: `NOT_RUN_REQUIRES_AUTHORIZATION`
- SAMPLE_ACCEPTANCE: `NOT_RUN_PHASE_2_BOUNDARY`
- DEPLOYMENT: `NOT_RUN`
- HUMAN_UAT: `NOT_RUN`

Phase 3 was not entered. Phase 3-9 remain `PENDING` and require separate
authorization. Phase 2 result: `PHASE_2_PASS_READY_FOR_SUPERVISOR_REVIEW`.

### Phase 2 B Resolution - 2026-08-29

The authorized solution is an append-only
`backlink_commercial_discovery_seed_provenance_assertions` fact table. It keeps
the canonical seed immutable while durably recording a later same-value
`USER_INPUT` assertion with full tenant/project/generation/seed lineage, source,
validation, evidence, confidence, actor, request, and deterministic idempotency
fingerprint. A composite foreign key binds every assertion to the exact canonical
seed identity. Forced tenant RLS, unique assertion idempotency, indexes, grants,
and immutable UPDATE/DELETE guards apply.

The repository writes the canonical seed and assertion in one tenant transaction.
Its current-effective-set query selects the highest-priority durable assertion
(`USER_INPUT` before generated/system sources), merges append-only evidence, and
continues excluding any seed referenced by a same-generation successor. The
canonical fallback row is never updated or deleted. Blueprint membership retains
the canonical seed ID/fingerprint and fails closed if immutable assignments no
longer match the current effective set.

Fresh verification:

- Manifest head: `0080`; migration ID `backlinks-0080`; order `271`;
  prerequisite `backlinks-0079`.
- 0080 actual and manifest SHA-256:
  `f949174e7a4fc6c46e8d715ad347e8e613a67eaaf48397df340b3bca1436318b`;
  exact match.
- `npm run migration:backlinks:check`: exit `0`,
  `Backlinks migrations valid: 72 files through 0080.`
- `npx vitest run
  test/backlinks/integration/recommendation-pool-v2-schema-migration.test.ts
  --maxWorkers=1`: exit `0`, `1/1` file and `2/2` tests. This covered the
  disposable 0079-to-0080 upgrade, assertion RLS, composite FK, uniqueness, and
  immutable guards.
- The repository integration installs the full manifest through 0080 into a
  fresh disposable PostgreSQL container. Its final aggregate run passed `6/6`,
  including A, B, C, tenant/workspace/project isolation, concurrent replay,
  assertion idempotency, and assertion UPDATE/DELETE rejection.
- `npx vitest run test/unit/recommendation-seed-preparation-phase2.test.ts
  test/unit/recommendation-seed-readiness-wiring-phase2.test.ts
  test/backlinks/api/recommendation-seeds-route.test.ts
  test/backlinks/integration/recommendation-seed-repository.test.ts
  --reporter=verbose --maxWorkers=1`: exit `0`, `4/4` files and `25/25` tests.
  One preceding aggregate attempt had a transient disposable-container/pool
  timeout (`23/25`); the isolated concurrent case then passed in `82ms`, and the
  clean aggregate rerun passed all `25/25` without changing production logic or
  timeouts.
- `npm run typecheck`: exit `0`.
- Focused ESLint over nine Phase 2/schema files and the three shared wiring files:
  exit `0`, no findings.
- Focused Prettier over the nine Phase 2/schema TypeScript files: exit `0`.
  Neither the shared dirty files nor the manifest received a whole-file format.
  Content-hash comparison confirms both HEAD and current manifest have
  pre-existing whole-file Prettier differences; this run changed only the 0080
  entry/hash.
- `npx vitest run test/backlinks/api/recommendation-commands-route.test.ts
  test/unit/recommendations-command.test.ts
  test/backlinks/api/private-server.test.ts test/unit/production-runtime.test.ts
  test/unit/local-product-dataforseo-runtime.test.ts --reporter=verbose
  --maxWorkers=1`: exit `0`, `5/5` files and `65/65` tests.
- Production call-graph inspection confirms seed route registration,
  API/worker repository-command composition, and the readiness gate call from the
  real product `execute()` path. The Phase 2-owned source edge scan found no
  Phase 3 provider, Workflow, Temporal, release, Opportunity, feed, frontend, or
  cutover edge.

All database writes were confined to disposable PostgreSQL test containers.
Real Provider/AI/Browser/DataForSEO/Gmail calls and cost were `0`; local product
database writes, manual SQL, service operations, Temporal/Worker business
operations, fabricated candidates, commit, push, and deployment were all `0`.
Phase 1 remains `PASS`. Phase 3 was not entered.

### Phase 3 B6B-B1A Activity Guards - 2026-08-30

Checkpoint:
`BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-3-B6B-B1A-ACTIVITY-GUARDS-001`.
Checkpoint result: `SUPERVISOR_VERIFIED_PASS`. Phase 3 remains blocked because
this checkpoint does not resolve the global relay atomic pre-claim contract.

Ownership ledger:

- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`:
  `W5_PHASE3_OWNED` only for the generation/job guard imports and the
  `backlinksReserveRecommendationRefillV1` /
  `backlinksExecuteRecommendationRefillV1` transaction-local guard hunks.
  Existing Phase 2 seed wiring, earlier Phase 3 runtime guards, provider
  availability changes, and all other mixed dirty hunks were preserved.
- `backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts`:
  `W5_PHASE3_OWNED` only for the contract terminal type import, the two activity
  result unions, and the immediate terminal return after execute. The existing
  retry-delay hunk was preserved.
- `backend/core/test/unit/recommendation-pool-v1-activity-guard.test.ts`:
  `W5_PHASE3_OWNED`, new focused test.
- `backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts`:
  status-only/pre-existing baseline, not edited.
- `backend/core/src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.ts`:
  prior Phase 3 guard implementation, reused without modification.
- This evidence hunk: `W5_PHASE3_OWNED`.
- `OWNERSHIP_CONFLICT`: `0` for the exact checkpoint hunks.

Implemented behavior:

- Reservation now checks the exact generation contract inside the same tenant
  transaction and before `reserveRecommendationRefillJob`. A V2, frozen, or
  otherwise non-applicable contract returns the typed
  `contract_not_applicable` terminal without reservation/job/outbox/provider
  ledger writes. Guard query failures propagate before the write.
- Provider execution now checks the exact job contract inside the same tenant
  transaction and before
  `assertRecommendationRefillProviderExecutionCurrent`. The typed terminal is
  returned before `dataForSeoRuntime.execute`, so non-applicable/frozen
  contracts and guard query failures cannot call the provider.
- The refill orchestration accepts the existing typed terminal from reserve or
  execute and returns it before candidate store, completion, or ordinary refill
  failure facts. It does not fabricate `started` and does not classify contract
  inapplicability as a provider/refill failure.
- The V1 applicable path retains the existing reservation, provider assertion,
  execute, store, and completion behavior.

Fresh verification:

- Initial focused red run: `3` tests, `2` failed because reservation lacked the
  transaction-local guard and execute terminal handling entered candidate
  preparation. A later combined regression exposed one existing malformed-input
  precedence mismatch (`56/57`); the runtime retained the prior
  `INPUT_REQUIRED` precedence while preserving valid V2 fail-closed behavior.
- `npm exec -- vitest run
test/unit/recommendation-pool-v1-activity-guard.test.ts
test/unit/recommendation-pool-contract-guard.test.ts
test/unit/recommendation-pool-v1-runtime-guard.test.ts
test/unit/production-runtime.test.ts
test/backlinks/integration/recommendation-refill-workflow.test.ts
--maxWorkers=1`: exit `0`, `5/5` files and `61/61` tests.
- The new tests cover V2, global freeze, non-`V1_ACTIVE`, and guard-query
  failures for both activities; they assert no domain-write SQL, enforce source
  call order, and verify that orchestration performs no execute/store/complete
  or ordinary failure work after the corresponding terminal.
- `npm run typecheck`: exit `0`.
- Focused ESLint over the two production files and the new test: exit `0`.
- Focused Prettier check for the new test: exit `0`. No whole-file formatter was
  run on either shared dirty production file. Their whole-file Prettier
  differences also exist in the corresponding HEAD versions; the owned hunks
  were manually kept equivalent to repository formatting.
- Scoped `git diff --check` for the two tracked production files: exit `0`.
  The new untracked test passed Prettier and contains no trailing whitespace.
- A scoped Phase 4 edge scan over the three checkpoint code/test files found no
  recommendation-feed, contact-preparation, canonical-batch, release, or
  cutover reference.

Side effects and stop conditions:

- Supervisor verification accepted the real transaction-local reserve/execute
  guards, typed workflow terminal, `5/5` files and `61/61` tests, Core
  typecheck, focused ESLint, and scoped diff check.
- Real Provider/AI/Browser/DataForSEO/Gmail calls and cost: `0`.
- Product database migration/apply/manual SQL: `0`.
- Service start/stop and Temporal/Worker business operations: `0`. Workflow
  bundling occurred only inside the fixture-backed test process.
- Candidate fabrication, commit, push, and deployment: `0`.
- Phase 3 cannot pass because the global recommendation outbox relay atomically
  claims rows before payload, project contract, and global-freeze eligibility
  can be applied. The existing claim changes the row to `processing`, writes
  claim fields, and increments `attempt_count`; filtering or releasing after
  claim therefore already violates the required zero-mutation result.
- A separate pre-query is subject to TOCTOU. In-memory filtering,
  pre-query-only gating, claim-then-release, and weakened zero-side-effect
  assertions are not acceptable fixes and were not used.
- Required user decision: authorize an additive, contract-aware atomic outbox
  claim schema/migration so V2, non-`V1_ACTIVE`, frozen, and contract-query
  failure rows remain unmodified during claim.
- No migration was implemented in this checkpoint.
- Phase 3 result: `BLOCKED_AT_PHASE_3_B6B_B1_PRECLAIM_SCHEMA`.
- Phase 4 was not entered.

### Phase 3 B6B-B1 Atomic Pre-claim Schema Recovery - 2026-08-30

Task ID:
`BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-3-B6B-B1-PRECLAIM-SCHEMA-RECOVERY-001`

Result: `PHASE_3_PASS_READY_FOR_SUPERVISOR_REVIEW`

Ownership ledger:

- `W5_PHASE3_OWNED`: the complete new `0081` migration and disposable
  PostgreSQL migration test; the exact `0081` manifest entry/hash; the exact
  atomic-claim routing hunk in `outbox.repository.ts`; the focused repository
  unit test; and the exact fixture/expectation hunk in the existing outbox
  relay integration test.
- `W5_PRIOR_OUT_OF_PHASE_SIDE_EFFECT`: the frozen `0080` migration and its
  manifest entry. Neither was edited by this recovery.
- `PRE_EXISTING_USER_OWNED`: all other tracked or untracked workspace changes,
  including shared runtime, workflow, API, Generated Client, frontend, and
  Phase 4-9 files. They were not edited, reverted, cleaned, or formatted.
- `DEFERRED_INERT`: pre-existing Phase 4-9 recommendation feed, contact,
  release, Opportunity, frontend, and cutover files remain outside this
  recovery and were not activated.
- `OWNERSHIP_CONFLICT`: `0` for the exact recovery hunks.

Implementation and contract result:

- Added forward-only migration
  `0081_backlink_recommendation_refill_atomic_preclaim.sql`.
- The generic `backlink_claim_outbox_events` function preserves the existing
  untyped/non-recommendation relay contract while atomically excluding
  `backlinks.recommendation-refill.requested.v1`.
- A dedicated atomic recommendation-refill claim function validates event
  type, payload schema, immutable scope and generation lineage, V1 generation,
  project `V1_ACTIVE` contract, and global non-frozen state before the same SQL
  statement mutates status, claim fields, or `attempt_count`.
- V2, non-`V1_ACTIVE`, global freeze, malformed or mismatched lineage, and
  guard-query failure return zero claimed rows with zero outbox mutation.
- Untyped/global repository claims pass `NULL` to the generic function and
  continue to claim eligible non-recommendation events. They do not throw an
  event-type-required error and cannot claim recommendation-refill events.
- Existing stale reclaim, retry, idempotency, and concurrent
  `FOR UPDATE SKIP LOCKED` behavior is preserved.
- The Phase 3 cutover-control shape includes nullable
  `frozen_by_run_id uuid`. Phase 3 cannot create or require the deferred
  Phase 8/9 run table. The disposable PostgreSQL test proves a forward
  migration can create that run table, backfill the nullable column, set it
  `NOT NULL`, and add the expected foreign key without changing or dropping
  the Phase 3 table.

Red-to-green evidence:

- Repository unit red run: `1` failed and `3` passed because untyped claim
  threw `BACKLINK_OUTBOX_EVENT_TYPE_REQUIRED`.
- Disposable PostgreSQL red run: `1` failed and `14` passed because
  `frozen_by_run_id` was absent.
- After the minimal fixes, the combined focused command
  `npm exec -- vitest run test/unit/outbox-repository.test.ts
  test/backlinks/integration/recommendation-refill-outbox-preclaim-migration.test.ts
  test/backlinks/integration/outbox-relay.test.ts --maxWorkers=1` exited `0`:
  `3/3` files and `27/27` tests in `12.72s`.
- The disposable PostgreSQL schema/claim suite independently passed `15/15`.
  It covers fresh migration through `0081`, `0080` to `0081` upgrade and
  reapply, function search path/privileges, eligible V1 claim, every
  non-V1 project state, global freeze, malformed and mismatched lineage,
  query failure, zero mutation, stale reclaim, generic exclusion, and a
  concurrent single winner.
- `npm run migration:backlinks:check` from `backend/core` exited `0`:
  `Backlinks migrations valid: 73 files through 0081.`
- The manifest SHA-256 matches the migration:
  `048fa2e51e72b9fffd228bf52e3ff77c5a2e301660f748a8a3eea7e0d0d872bf`.
- `npm run typecheck` from `backend/core` exited `0`.
- Focused ESLint over the four touched TypeScript files exited `0`.
- Focused Prettier checks for both new test files exited `0`. Whole-file
  Prettier differences in `outbox.repository.ts`, `outbox-relay.test.ts`, and
  `deployment-manifest.v1.json` also exist in their HEAD versions; no
  whole-file formatter or `--write` was used, and the owned hunks were kept
  formatter-equivalent.
- The existing V1/runtime/workflow regression command over five files exited
  `0`: `5/5` files and `61/61` tests in `12.99s`.
- Scoped tracked `git diff --check` exited `0` apart from line-ending warnings;
  both new files also passed the explicit whitespace/final-newline check.
- The recovery touched no runtime, activity, Workflow registration, route,
  API, Generated Client, frontend, canonical batch, contact, release,
  Opportunity, or Phase 4 implementation path.

Changed files:

- `backend/core/src/modules/backlinks/db/migrations/0081_backlink_recommendation_refill_atomic_preclaim.sql`
- `backend/database/deployment-manifest.v1.json`
- `backend/core/src/modules/backlinks/db/repositories/outbox.repository.ts`
- `backend/core/test/unit/outbox-repository.test.ts`
- `backend/core/test/backlinks/integration/recommendation-refill-outbox-preclaim-migration.test.ts`
- `backend/core/test/backlinks/integration/outbox-relay.test.ts`
- `docs/execution/backlinks-recommendation-pool-v2-full-implementation-001.md`

Layered result:

- `IMPLEMENTED`: `PASS`
- `TESTED`: `PASS`
- `LOCAL_RUNTIME`: `NOT_RUN` - services were not started in this schema
  recovery.
- `REAL_PROVIDER`: `NOT_RUN_REQUIRES_AUTHORIZATION`
- `SAMPLE_ACCEPTANCE`: `NOT_RUN`
- `DEPLOYMENT`: `NOT_RUN`
- `HUMAN_UAT`: `NOT_RUN`

Side effects and stop condition:

- Real DataForSEO/AI/Browser/Gmail/Provider calls and cost: `0`.
- Product database migration apply/manual SQL: `0`; PostgreSQL work used only
  disposable test containers.
- Service start/stop, Temporal/Worker business operations, candidate
  fabrication, commit, push, and deployment: `0`.
- Phase 3 is ready for independent supervisor review.
- Phase 4 was not entered.
