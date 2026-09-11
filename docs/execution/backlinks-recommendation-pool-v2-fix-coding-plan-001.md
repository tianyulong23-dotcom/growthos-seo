# Backlinks Recommendation Pool V2 Fix Coding Plan 001

- Date: 2026-09-03
- Last amended: 2026-09-04
- Status: GATE_0_PASS
- Task ID: `BACKLINKS-RECOMMENDATION-POOL-V2-FIX-001`
- Gate model: 11 gates total, numbered `Gate 0` through `Gate 10`
- Final product state: `V2_ONLY_RECOMMENDATION_POOL`
- Implementation evidence path: `docs/execution/backlinks-recommendation-pool-v2-fix-implementation-001.md`
- Authoritative product requirements:
  - `docs/architecture/backlinks-recommendation-pool-product-requirements-v2.md`
  - `docs/architecture/backlinks-recommendation-pool-v2-compatibility-and-coding-plan.md`

## 1. Start Card

| Item | Value |
| --- | --- |
| Repository | `C:\Users\DELL\Documents\缝合\john3947-seo-main` |
| Remote | `https://github.com/john3947/seo.git` |
| Branch | `main` |
| Baseline HEAD | `7df8d48d088328bd79fb0a1afef364b17cc8b6af` |
| Baseline worktree | Concurrent dirty worktree; the entry count changed `255 -> 262 -> 256` during this audit. The complete V2 migration chain 0080-0090, the V2 pool/seed repositories and several V2 services, routes and tests are untracked. Their current migration SHA-256 values match the modified deployment manifest, but the manifest also contains broad full-file formatting churn |
| Gate 0 owned files | This document, the implementation evidence document, the declarative V2 operational-policy constants and focused policy test, and narrowly scoped maintenance of stale V2 migration tests/runners whose frozen-head or out-of-order assumptions prevent the current 0080-0090 chain from running |
| Provider ceiling for planning | DataForSEO: 0; Gmail: 0 |
| Deployment | Not authorized |
| Commit/push | Not authorized |
| Gate 0 local authorization | The 2026-09-03 instruction to resolve the Gate 0 blockers authorizes task-scoped local evidence, repository-external byte-preserving checkpoints, ownership ledgers, hashes, diagnostics, rollback-only tests, and declarative V2 policy constants with focused tests. It does not authorize runtime wiring, a Git branch/commit/push, migration 0091, production service/workflow/frontend edits, provider calls, deployment or durable business-data writes |
| Stop point | Complete Gate 0 only. Do not start migration 0091 or production schema/service/workflow/frontend edits |

### Evidence labels

This plan keeps the following evidence layers separate:

1. `IMPLEMENTED`
2. `TESTED`
3. `LOCAL_RUNTIME`
4. `REAL_PROVIDER`
5. `SAMPLE_ACCEPTANCE`
6. `DEPLOYMENT`
7. `HUMAN_UAT`

No layer may be inferred from a lower layer. In particular, green unit tests do not prove native V2 recommendation generation, and a working local route does not prove deployment or human acceptance.

### Final product-state contract

The final exit from Gate 10 is not merely permission to enable V2. It must leave
`recommendation-pool.v2` as the only executable recommendation-pool
implementation used by Backlinks projects.

At final exit:

- every eligible existing project and every newly created project uses V2;
- all recommendation UI, API, Worker, Workflow, recovery, relay, reservation,
  discovery, refill and Provider control paths are V2-only;
- no production composition registers a V1 recommendation write route,
  Workflow, activity, relay, periodic job, recovery scan or fallback;
- no new V1 recommendation generation, candidate, refill, job, outbox,
  reservation, lease or Provider fact can be written;
- the V2 feed continues through the existing canonical Opportunity, Draft,
  Send, Reply, Placement and Reports chain without using a V1 score, inventory
  publication state or recommendation identity as business authority;
- historical V1 facts may remain only as sealed, immutable audit evidence
  required to preserve existing Opportunity, Draft, Placement and report
  history. They are not an active recommendation pool, are not writable and
  are not reachable from recommendation product control paths.

The 2026-09-04 user authorization incorporates the previously optional V1
recommendation-pool physical cleanup into Gate 10. This does not authorize
deleting or rewriting historical business evidence merely to remove the string
`V1`.

## 2. Current Verdict

| Area | Verdict | Evidence |
| --- | --- | --- |
| V2 schema shell, seed facts, discovery ledger, batches and user cursors | PARTIALLY IMPLEMENTED | Migration 0080 and V2 repositories contain these concepts |
| V1 generation freeze and migration guards | LOCALLY PROTECTED | Existing V2 tests and migration guards cover important side effects |
| Native V2 candidate discovery and admission | FAIL | Candidate counting, qualification and publication still depend on V1 commercial score/state |
| V2 generation contract identity | FAIL | V2 launch copies `recommendation-qualification.v1` and `recommendation-commercial-fit.v4`; database constraints require those values |
| Canonical release/downstream lineage | HIGH-RISK COMPATIBILITY BOUNDARY | Native release items require commercial candidate, recommendation, prospect and inventory identities even though those rows currently carry V1 semantics |
| Low-yield completion semantics | FAIL | Zero V1-qualified candidates becomes `INPUT_REQUIRED` and no V2 publication |
| Historical released-site visibility | FAIL | Feed projection is bound to the current generation/context/input pin |
| Seed review and confirmation UX | FAIL | Generate sends `{ seeds: [] }`; the seed preparation service is not exposed as a review-confirm workflow |
| New-project V2 seed readiness | FAIL | Seed binding returns `DISCOVERY_BLUEPRINT_REQUIRED` unless an active legacy commercial Blueprint already exists |
| V2 canonical compatibility carrier | NOT DESIGNED | Commercial candidates require legacy Blueprint/batch foreign keys and old inventory `PUBLISHED` requires V1 fit plus verified email |
| Generation progress and failure visibility | FAIL | UI keeps showing the previous published pool and does not expose the new generation terminal result |
| Real-provider sample acceptance | FAIL | AWOL sample produced provider results but zero admitted native V2 candidates |
| Performance diagnosis | INCOMPLETE | Provider time is known, but the long queue/idle interval is not yet instrumented precisely |
| Temporal workflow upgrade safety | NOT PROVEN | Existing V2 workflows may wait for contact preparation for up to 24 hours; changing workflow control flow can cause replay nondeterminism |
| Migration deployment integration | REQUIRED | A new migration must also update the deployment manifest head, step, prerequisite and exact SHA-256 |
| Coding baseline integrity | PASS AT GATE 0 | The untracked 0080-0090 chain is checkpointed and hash-matched; point-migration tests preserve their target boundary, historical runners accept later append-only heads, and the policy freeze is declared without runtime wiring |
| Deployment and human UAT | NOT RUN | Outside the completed evidence boundary |

The present system is therefore not a complete V2 recommendation pool. It is a V2 orchestration and release shell around a V1 candidate authority.

Production coding may start only after Gate 0 resolves file ownership, freezes the remaining product-policy decisions, reproduces the current failures, and locks the canonical V2 materialization contract. Future-schema behavior is expressed as expected-red Gate 1 tests and becomes a passing production contract only in Gate 2; Gate 0 must not duplicate migration 0091 as throwaway test-only DDL.

## 3. Confirmed Root Causes

### RC-01: V1 commercial qualification is still the V2 admission authority

The V2 executor counts candidates from `backlink_commercial_candidates` only when they have V1 commercial states and `score_model_version = 'recommendation-commercial-fit.v4'`. The discovery service also removes candidates whose V1 `commercialScore.decision` is not `eligible`.

This violates the V2 requirement that admission is based only on:

- self-domain exclusion;
- invalid or unreachable domain;
- malicious or explicitly blocked site;
- duplicate domain;
- clearly unrelated site;
- permanent exclusion.

SEO metrics, spam score, contact state, or a fixed numeric score may annotate and prioritize a candidate, but may not decide whether the site enters the V2 pool.

### RC-02: V2 has no independent candidate fact authority

Migration 0080 adds rich V2 generation, seed, request, round, terminal, batch and user-release facts, but it does not add a canonical V2 generation-candidate table. Release items are ultimately populated from the old commercial candidate model.

This makes the most important product decision, "is this website a valid V2 recommendation candidate?", impossible to represent independently from V1 scoring.

### RC-03: Discovery executes too few and too narrowly ordered requests

The current executor allows one request per round and advances through a flat request list. The request list is ordered by subject first, then pattern. Consequently, the two paid requests observed in the real sample were both based on the first subject and only changed the pattern:

1. `"Soft Gray Screen" "write for us" United States`
2. `"Soft Gray Screen" "contribute" United States`

The implementation does not satisfy the V2 contract of trying multiple search paths within each bounded round, deduplicating requests, and exhausting meaningful dimensions before declaring low yield.

### RC-04: A successful low-yield discovery is converted into a qualification failure

The real sample returned 17 raw rows and 6 unique domains. Five were marked insufficient data and one was excluded by a V1 score of approximately 30.47 against a threshold of 50. The executor then counted zero "native candidates", and the workflow completed as `RECOMMENDATION_POOL_V2_NO_NATIVE_CANDIDATES` with `INPUT_REQUIRED`.

The V2 requirement is different:

- 1 to 99 valid candidates after bounded exhaustion: publish them and use `PARTIAL_EXHAUSTED`;
- metric or contact-data absence: preserve the candidate with nullable facts;
- zero valid candidates after all permitted hard exclusions: report a truthful empty terminal outcome, not a score-qualification failure;
- provider or internal execution error: use `FAILED`;
- missing or invalid seeds before discovery: use `INPUT_REQUIRED` without provider calls.

### RC-05: Discovery-dimension accounting can claim a change that did not happen

The finalizer currently records `KEYWORD` as changed when only a canonical request fingerprint changes inside the same standard queue. A round transition must be backed by the actual changed dimension: keyword, category, competitor, market, language, pattern, endpoint, or another explicitly modelled dimension.

### RC-06: The feed hides historical released entitlement

The visible feed query starts from publication facts but constrains results to the current generation, context and input pin. This violates the product requirement that a user can continue to see all websites released to them across historical publications, subject to archive and permanent-exclusion rules.

### RC-07: The frontend launches generation but does not operate the V2 lifecycle

The current frontend:

- posts `{ seeds: [] }` to the seed/generation endpoint;
- does not expose prepared seeds for user review and modification;
- refreshes once after launch instead of polling the generation state;
- continues to show the old published pool without clearly separating it from the newly running or failed generation;
- receives a release projection that does not contain the full generation state and terminal reason.

### RC-08: Performance spans are incomplete

The real sample took approximately 209 seconds. The two DataForSEO calls took approximately 7.83 and 6.07 seconds, while the recorded queue time was approximately 129.49 seconds. There was also an unexplained interval of roughly 120 seconds in the observed timeline.

The evidence does not yet prove whether the delay came from workflow scheduling, polling cadence, retry/backoff, worker capacity, contact enrichment, persistence, or another wait state. The fix must add durable span evidence before changing timeouts or concurrency.

### RC-09: The implementation baseline is not reviewable enough

The worktree is concurrently changing, and important V2 documents, migrations, services and tests are untracked. Even correct changes cannot be safely reviewed, reproduced or rolled back until file ownership and a checkpoint are established.

### RC-10: V1 contract versions are embedded below the workflow layer

The coupling is not limited to a numeric threshold in one service:

- `backlink_recommendation_generation_contracts` requires
  `recommendation-qualification.v1` and
  `recommendation-commercial-fit.v4`;
- the native V2 generation launcher copies those V1 values from the current
  generation;
- candidate, publication, query and recovery paths repeat the same version
  strings and eligibility predicates;
- `backlink_commercial_candidates` accepts only V1/V3/V4 commercial score
  versions and requires a non-null commercial score object.

Therefore, adding a V2 candidate table without changing the contract identity
will leave the generation labelled and guarded as V1. The fix needs a real V2
admission contract version, not a relaxed score threshold.

### RC-11: V2 admission authority and canonical downstream identity are conflated

Native V2 release items must reference:

- a commercial candidate;
- a recommendation;
- a prospect;
- an inventory row.

Opportunity creation and later outreach depend on those canonical identities.
Removing those foreign keys would expand the change into every downstream
workflow. Reusing the current V1 materializer unchanged would reintroduce the
same score and qualification authority.

The compatible design is a V2-owned candidate and admission fact plus a narrow
canonical materialization bridge. The bridge creates the existing canonical
identities without calling the V1 admission/qualification pipeline. Existing
foreign keys remain; authority changes.

### RC-12: Operational job state is being used as product outcome

The current zero-candidate branch sets the generation job to `failed` and writes
`INPUT_REQUIRED`, even when provider execution succeeded and the real reason is
bounded exhaustion. Discovery outcome, workflow health, contact preparation,
batch readiness and user-visible release are separate facts and must not be
collapsed into one job status.

### RC-13: Long-lived Temporal workflow code cannot be replaced in place blindly

The workflow can remain open for 24 hours while it polls contact preparation.
Changing branch order, timers, activity calls or result shapes while histories
are in flight can cause Temporal replay nondeterminism. The implementation must
inventory active histories and use replay testing plus a patch/versioning
strategy before a worker restart.

### RC-14: The immutable input pin is contract-bound to V1

`backlink_generation_input_pins` is immutable, and the generation-contract
foreign key includes both `input_pin_id` and `qualification_contract_version`.
The project-context projection command also rejects any input pin whose
qualification contract is not `recommendation-qualification.v1`. Therefore, a
new V2 generation cannot truthfully reuse the current V1 input pin after its
admission contract changes, and the old pin cannot be updated in place.

The fix must create or resolve a new immutable V2 input-pin snapshot that
references the same underlying project/profile/evidence versions but includes
the V2 admission contract in its deterministic fingerprint. The V1 pin remains
unchanged and continues to serve historical lineage.

### RC-15: Project-wide domain uniqueness currently fails late

The release-item table already has a unique constraint across project and
canonical domain. The product contract also says a domain previously released
or already represented by a project Opportunity cannot be released again as a
new website. The current candidate plan only described deduplication inside one
generation, so a repeated historical domain could pass discovery and admission
and fail only while preparing a release item.

V2 admission must consult a project-domain registry derived from historical
release and Opportunity facts before batch selection. The database uniqueness
constraint remains the final invariant, not the normal duplicate-detection
mechanism.

### RC-16: V2 seed confirmation has a hidden V1 setup prerequisite

The current seed repository only binds confirmed V2 seeds to an already active
`backlink_commercial_discovery_blueprints` row. If the project has never
created that legacy commercial Blueprint, seed confirmation returns
`DISCOVERY_BLUEPRINT_REQUIRED`.

The authoritative coding document says the seed service should extend the
existing Blueprint model rather than inventing a second discovery model. That
means V2 seed preparation/confirmation must deterministically create or resolve
the project-context Blueprint itself. A user must not have to run V1 discovery
first to make V2 start.

The Blueprint remains an immutable seed/taxonomy lineage object. It does not
become V2 candidate-admission authority.

### RC-17: Canonical downstream identities require legacy-shaped carrier rows

`backlink_commercial_candidates` requires non-null `blueprint_id` and
`discovery_batch_id`, non-null JSON score/gate fields, an allowlisted
`score_model_version`, and an allowlisted commercial state. Its referenced
discovery batch also requires a legacy request intent. Separately, setting
`backlink_recommendation_inventory.publication_status = 'PUBLISHED'` requires a
V1 commercial-fit decision and verified public email.

Therefore, "materialize canonical IDs" is not a single insert. Without an
explicit adapter contract, implementation will either fail database
constraints or fabricate V1 discovery, score, fit or email facts.

V2 needs an explicit compatibility carrier:

- one deterministic V2-owned commercial discovery-batch row satisfying the old
  candidate foreign key;
- one explicit V2 materialized commercial-candidate state/version with
  non-scored payloads;
- an inventory compatibility row that remains non-`PUBLISHED`;
- V2 release-batch/item facts as the only publication and entitlement
  authority for V2.

The carrier must not be read for V2 admission, candidate count, yield, billing,
round control or release visibility.

### RC-18: The migration chain needed by 0091 is not yet a stable baseline

The current worktree contains the complete V2 migration chain 0080 through
0090, the V2 pool repository and the V2 seed repository as untracked files.
The deployment manifest is modified in the same concurrent worktree and
contains broad full-file formatting churn in addition to the 0080-0090
entries. The current 0080-0090 file hashes do match their manifest entries,
but neither side is a stable Git baseline.

Migration 0091 cannot be implemented safely against an unnamed or moving owner
of those prerequisites. Gate 0 must establish ownership and a reproducible
checkpoint or patch bundle for the exact 0080-0090 contents and matching
manifest hashes before any 0091 edit begins. The checkpoint must also establish
whether the manifest reformat is intentional so the 0091 change does not
silently absorb unrelated formatting ownership.

### RC-19: Phase 9 creates a canonical-materialization dependency cycle

`backlink_phase9_can_insert_v2_recommendation` currently permits a new
recommendation through the active V2 project contract. A staged replacement
generation is not active yet. However, the staged generation needs a
recommendation before it can create inventory and release-item lineage, while
project-contract rotation happens only after generation completion.

The guard must authorize a recommendation from exact V2 materialization
lineage, not merely from an active project contract or a matching context.
Migration 0091 must add nullable V2 lineage fields to
`backlink_recommendations`; historical rows remain all-null, while native V2
rows carry the complete generation lineage and are validated against the
existing V2 generation composite unique key.

### RC-20: Blueprint selection is active-latest, not seed-snapshot exact

The current seed repository selects the highest-version active Blueprint for a
project context, then binds the current generation's seeds to it. Blueprint
rows are immutable, and the selection does not prove that the chosen Blueprint
represents the confirmed seed snapshot.

V2 confirmation must compute an ordered seed-snapshot fingerprint, resolve an
exact matching V2 Blueprint or create the next immutable version, and serialize
creation by project context. A retry and a concurrent confirm must not bind the
generation to an unrelated latest-active Blueprint or create duplicate
versions.

### RC-21: Compatibility carrier lineage must be one composite database fact

Migration 0080 already exposes
`backlink_rec_generation_v2_lineage_uq` over tenant, project, generation,
context, visible generation, input pin and pool contract. The compatibility
batch must reference that exact key with one composite foreign key.

Separate foreign keys or application checks could independently validate a
generation ID and a context/generation pair that belong to different rows.
That split-lineage state is forbidden.

### RC-22: Historical migration tools confuse their target with the current head

Several point-migration tests and runners were written while their target
migration was the manifest head. They therefore required the current head to
equal `0080`, `0081`, `0085`, `0086`, `0087` or `0088`, and some tests applied
all later migrations before the migration under test.

This makes a valid append-only migration chain break old maintenance tooling.
Each point-migration test must preserve its own boundary by applying only prior
manifest steps before the target. Each runner must verify that its exact target
step and the current head both exist and that the head is at or after the
target, while retaining exact path, prerequisite, tool, recovery and hash
validation.

## 3.1 Pre-Coding Conflict Audit

| ID | Confirmed conflict or likely stall | Required prevention |
| --- | --- | --- |
| B-01 | Concurrent dirty/untracked work makes ownership and rollback ambiguous | Gate 0 file ledger, hashes and authorized checkpoint before edits |
| B-02 | Guessed or drifted migration, repository, service and route paths can stall implementation | Use only paths verified by `rg --files`; mark newly created files explicitly and fail the gate when an expected existing path does not exist |
| B-03 | Migration 0091 will fail the repository check if it is absent from the deployment manifest | Update `backend/database/deployment-manifest.v1.json`, head `0091`, prerequisite `backlinks-0090` and exact SHA-256 in the same change |
| B-04 | Generation contracts and launch code still pin V1 qualification/score versions | Add and persist an explicit V2 admission contract version before candidate ingestion |
| B-05 | Native release items require old canonical IDs and downstream Opportunity consumes them | Add a V2-to-canonical materialization bridge; preserve existing release-item foreign keys |
| B-06 | `backlink_commercial_candidates` cannot currently represent a non-V1 compatibility row truthfully | Add an explicit V2 compatibility contract/state in 0091; never insert fake V4 eligible scores |
| B-07 | Phase 9 recommendation guards authorize inserts through the active V2 generation, not necessarily a staged replacement generation | Extend and regression-test guards for a valid staged V2 generation before materialization |
| B-08 | Generation completion fields are immutable after first completion | Repair by creating a fresh higher generation and atomic rotation; never mutate the failed historical generation |
| B-09 | The executor and ledger model one request result per round | Redesign per-request intent/reservation/outcome aggregation before increasing `maxRequests` |
| B-10 | API changes cross Core route, Python gateway, OpenAPI and generated frontend client | Change source contract first, test gateway, regenerate client, then update UI |
| B-11 | Existing Temporal histories can replay old control flow for up to 24 hours | Inventory histories, add replay tests and use Temporal patching or a new workflow type/build rollout |
| B-12 | Real-provider acceptance may legitimately wait for contact convergence until the 24-hour deadline | Record durable IDs and separate discovery, candidate, batch-preparing and first-visible timings; do not claim completion early |
| B-13 | Product requirements still contain implementation-time decisions | Freeze policy versions and defaults in Gate 0 before coding behavior |
| B-14 | The immutable input pin and its composite generation FK are bound to the V1 qualification contract | Create a deterministic V2 input-pin snapshot; update projection/launch validation; never mutate or relabel the V1 pin |
| B-15 | Historical release and Opportunity duplicates can reach the project-domain unique constraint only at batch insert | Resolve project-domain ownership before admission/batch selection and preserve the unique constraint as a race guard |
| B-16 | Seed confirmation fails for projects without an active legacy commercial Blueprint | Make V2 seed confirmation create or resolve the existing Blueprint model deterministically; never require a V1 discovery run |
| B-17 | Commercial candidate foreign keys require a Blueprint and discovery batch even when V1 discovery is not authoritative | Add an explicit V2 compatibility-batch contract linked to the V2 generation; do not call the V1 discovery service |
| B-18 | Old inventory `PUBLISHED` requires V1 fit and verified email and cannot truthfully represent V2 release | Keep compatibility inventory non-`PUBLISHED`; use V2 release batch/item/publication tables as the visibility authority |
| B-19 | Candidate admission can finish quickly while a release batch may legitimately wait up to 24 hours for contact terminal facts | Test and expose separate admitted, batch-preparing and batch-available states; never treat contact wait as candidate failure |
| B-20 | Migration 0091 depends on the untracked 0080-0090 chain and a modified manifest with broad formatting churn | Treat Gate 0 as a hard stop until owners, exact hashes and manifest-format ownership are recorded and an authorized reproducible checkpoint or patch bundle exists |
| B-21 | Phase 9 recommendation insert authorization depends on the active project contract, creating a staged-generation materialization cycle | Put exact V2 generation lineage on the new recommendation row and authorize the insert from that lineage before inventory/release creation |
| B-22 | Seed confirmation selects the latest active Blueprint without proving seed-snapshot identity | Add an ordered seed-snapshot fingerprint, context-scoped serialization and exact retry/concurrency tests |
| B-23 | Carrier generation ID and context fields could be validated separately and accidentally point to different generation rows | Use one composite foreign key to `backlink_rec_generation_v2_lineage_uq`; add a negative split-lineage constraint test |
| B-24 | Point-migration tests/runners require an obsolete exact manifest head or apply later migrations before their target | Derive the current head from manifest order, preserve each test's target boundary, and allow a runner only when the current head is at or after its exact hash-checked target |

No blocker above may be "solved" by manual SQL, synthetic candidates, fake
commercial scores, disabling constraints, re-enabling V1 refill, or hiding the
new generation failure behind the previous released pool.

## 4. Requirement-to-Code Gap Matrix

| V2 requirement | Current behavior | Required fix |
| --- | --- | --- |
| User can review and edit generated seeds | Frontend launches with empty seeds | Separate seed preparation, review/modify, confirmation and launch |
| A new project can start V2 without first running V1 | Seed binding requires an existing active commercial Blueprint | V2 seed confirmation deterministically creates/resolves the existing Blueprint model for the current project context |
| Multi-source, multi-path discovery | One request per round; first-subject-biased ordering | Fair request planner with multiple bounded intents per round |
| Round 1 at most USD 1; total at most USD 2 | Cost ledger exists, request breadth is insufficient | Keep ledger and hard ceilings; broaden requests inside budget |
| Stop paid discovery at 100 admitted unique domains; never retain more than 1,000 admitted/effective unique domains in the pool | Partial controls exist | Enforce the 100 target at the request scheduler and the 1,000 hard pool ceiling at V2 admission authority |
| Metrics are soft signals | V1 score decides eligibility | Store nullable metrics independently; remove score gate |
| Contact is not an admission gate | V1 state may require contact-related progression | Admit before contact; enrich asynchronously with terminal facts |
| No fixed recommendation score | V1 V4 score controls selection | Remove score from admission/count/publication |
| V2 generation has its own contract identity | V2 generations copy V1 qualification and score versions | Add a V2 admission contract version and stop V2 launch/read paths from matching V1 versions |
| V2 generation has a truthful immutable input pin | Current immutable input pin and projection validation are pinned to V1 qualification | Create/reuse a V2-specific immutable pin from the same source versions and bind the generation to it |
| Preserve Opportunity/outreach compatibility | Release items require old canonical IDs | Materialize compatible canonical identities from V2 facts without invoking V1 admission |
| Preserve old canonical foreign keys without giving them V2 authority | Candidate requires legacy Blueprint/batch and old inventory publication requires V1 fit/email | Create explicit V2 compatibility carrier rows; keep inventory non-`PUBLISHED`; publish only through V2 release facts |
| Never re-release a historical project domain as new | Project-level release uniqueness currently rejects duplicates late | Exclude domains already released or represented by an Opportunity before batch selection |
| Publish usable low-yield results | Zero V1-qualified candidates means no publication | Publish 1 to 99 valid candidates as `PARTIAL_EXHAUSTED` |
| Stable batches and per-user cursor | Mostly implemented | Preserve and retest against new candidate authority |
| Get More makes no provider call | Locally implemented | Preserve with a zero-provider regression gate |
| Show all historically released sites | Current-generation filter hides older releases | Build entitlement projection across all release history |
| Show truthful generation state | Release status hides active/failed generation | Add generation projection and frontend state separation |
| V1 active generation and writes remain zero | Guards exist | Preserve database, route and provider-side invariants |

## 5. Protected Working Areas

The fix must preserve these already useful V2 capabilities:

- V1 active generation is frozen.
- V1 refill and provider-write paths remain disabled.
- V2 release batches and release items are canonical and immutable after publication.
- Per-user release cursors, unlock, archive and restore behavior remain server-authoritative.
- Get More reveals an existing prepared batch and performs zero provider calls.
- The public V2 response does not expose a numeric recommendation score.
- Feed filtering and export remain server-side.
- Contact enrichment has terminal facts and can feed the downstream outreach chain.
- The fake-provider downstream path from recommendation to Opportunity, Draft, Send, Reply, Placement and Reports remains covered.

Any regression in this list blocks completion.

## 6. Target Architecture

```text
Project facts
  -> Seed preparation
  -> User seed review and confirmation
  -> Existing Blueprint model resolved/created as seed lineage
  -> Generation snapshot
  -> V2 admission-policy snapshot
  -> Bounded discovery request planner
  -> Provider usage ledger and request intents
  -> Raw candidate evidence
  -> Canonical domain normalization
  -> V2 hard-exclusion admission
  -> Nullable metric and contact enrichment
  -> Recommended-marker derivation
  -> Canonical identity materialization bridge
       -> V2 compatibility discovery-batch carrier
       -> commercial candidate compatibility identity
       -> prospect
       -> recommendation
       -> inventory
  -> Prepared release batches
  -> Publication
  -> Historical user entitlement projection
  -> Opportunity and outreach workflow
```

The critical ownership rule is:

> A V2 generation candidate fact, not a V1 commercial score row, is authoritative for counting, admission, batch preparation and publication.

V1 commercial scoring may remain available as historical/advisory evidence for a recommended marker during migration, but it must not exclude, count, materialize or publish V2 candidates.

## 7. Required Data Model

Add a forward-only migration after the current latest migration. Do not rewrite migrations 0080 through 0090.

Required migration path:

`backend/core/src/modules/backlinks/db/migrations/0091_backlink_recommendation_pool_v2_candidate_facts.sql`

### 7.1 `backlink_recommendation_generation_candidates`

Minimum facts:

- tenant, project and generation identity;
- canonical domain;
- admission state: `ADMITTED` or `EXCLUDED`;
- nullable hard-exclusion code;
- admission contract version and immutable decision evidence;
- first-seen request intent;
- recommended marker and reason code;
- first-seen and admitted/excluded timestamps;
- unique `(organization_id, workspace_id, website_project_id,
  generation_contract_id, canonical_domain)`.

Allowed hard-exclusion codes must be an explicit closed set, for example:

- `SELF_DOMAIN`
- `INVALID_DOMAIN`
- `UNREACHABLE_DOMAIN`
- `MALICIOUS_OR_BLOCKED`
- `ALREADY_RELEASED_TO_PROJECT`
- `EXISTING_PROJECT_OPPORTUNITY`
- `OBVIOUSLY_UNRELATED`
- `PERMANENTLY_EXCLUDED`

There must be no score-threshold exclusion code.

The candidate fact is immutable. A repeated provider row for the same domain
adds source evidence to the existing candidate and increments duplicate
accounting; it does not create a second admitted candidate or a fake exclusion.

Before an otherwise valid candidate becomes `ADMITTED`, admission must query a
tenant/project-scoped domain registry containing at least:

- all historical V2 release items for the project;
- all existing project Opportunities by canonical target domain;
- any preserved legacy release identity that the authoritative migration maps
  into the same project-domain namespace.

An already released or Opportunity-owned domain keeps its new source evidence
but receives the matching exclusion code and cannot enter a new canonical
batch. This check and release-item creation must remain protected by the
existing project-domain unique constraint so concurrent generations cannot
release the same domain twice.

### 7.2 `backlink_recommendation_generation_candidate_sources`

Minimum facts:

- generation candidate;
- request intent and provider outcome;
- source type and discovered URL;
- provider artifact or evidence reference;
- evidence fingerprint;
- observed timestamp;
- unique evidence constraint preventing repeated storage.

### 7.3 `backlink_recommendation_candidate_metric_snapshots`

Minimum facts:

- generation candidate;
- metric kind;
- nullable value and value state;
- provider, endpoint, market, location and language context;
- request intent/artifact identity;
- observed timestamp.

Unavailable, failed or unsupported metrics must be represented explicitly and must not delete or exclude the candidate.

### 7.4 `backlink_recommendation_generation_candidate_links`

This is the compatibility boundary between V2 authority and the existing
Opportunity/outreach identity chain.

Minimum facts:

- generation candidate identity;
- commercial candidate identity;
- recommendation identity;
- prospect identity;
- inventory identity;
- materialization contract version;
- idempotency fingerprint and created timestamp;
- one-to-one uniqueness for a generation candidate.

Rules:

- materialization reads only an `ADMITTED` V2 candidate;
- it does not call V1 commercial scoring or V1 qualification services;
- it does not call the V1 commercial discovery service;
- it never writes a fake
  `recommendation-commercial-fit.v4` eligible decision;
- it creates or reuses a complete, tenant-scoped canonical identity set;
- retries return the same identities;
- downstream Opportunity and outreach code continues to use the canonical IDs.

Migration 0091 must extend the commercial candidate contract so a compatibility
identity can be represented explicitly as V2/advisory-only. The old JSON
columns may carry a closed, non-scored compatibility payload, but no code may
parse that payload as V1 eligibility.

#### 7.4.1 Existing Blueprint model

Reuse `backlink_commercial_discovery_blueprints` as required by the
authoritative coding document, but narrow its V2 role:

- V2 seed confirmation computes one deterministic fingerprint from the ordered
  eligible seed IDs, seed fingerprints and taxonomy/version inputs;
- migration 0091 adds a nullable `seed_snapshot_fingerprint` for legacy
  compatibility and a tenant/project/context partial unique constraint for
  non-null V2 fingerprints;
- confirmation first replays an existing generation-specific binding, then
  resolves the exact fingerprint, or creates the next immutable Blueprint
  version under a project-context advisory lock;
- selecting only `ORDER BY blueprint_version DESC LIMIT 1` is forbidden for V2
  confirmation;
- the Blueprint contains the confirmed seed/taxonomy snapshot and evidence
  references;
- its deterministic identity/version prevents duplicate creation on retry;
- no V1 provider request, commercial scoring or candidate admission is needed
  to create it;
- all generation-candidate authority remains in the V2 candidate tables.

Gate 0 must prove both cases: a project with an existing Blueprint and a new
project-context with none.

#### 7.4.2 V2 compatibility discovery-batch carrier

Because `backlink_commercial_candidates.discovery_batch_id` is mandatory, the
bridge creates one deterministic completed carrier in
`backlink_commercial_discovery_batches` for each V2 generation being
materialized.

Migration 0091 must make the carrier explicit rather than encoding it only in
an idempotency string:

- add nullable `generation_contract_id`, `pool_contract_version` and
  `materialization_contract_version` columns plus nullable `input_pin_id`,
  preserving all historical V1 rows;
- for a V2 carrier require the exact generation, context, visible generation
  and Blueprint lineage;
- bind `(organization_id, workspace_id, website_project_id,
  generation_contract_id, project_context_version_id,
  visible_pool_generation, input_pin_id, pool_contract_version)` with one
  composite foreign key to `backlink_rec_generation_v2_lineage_uq`;
- reject partially populated V2 lineage and reject a carrier whose fields come
  from different generation rows;
- add `V2_MATERIALIZATION` to the closed `request_intent` set and use it only
  for this adapter row;
- set the carrier `status` to `completed`, with deterministic
  `idempotency_key`, `started_at` and `finished_at`;
- set `source_types = '["V2_CANONICAL_MATERIALIZATION"]'::jsonb`,
  `provider_request_fingerprints = '[]'::jsonb` and
  `provider_collected_at = NULL`;
- set `paid_cost_micros = 0`; the V2 request-intent/outcome/usage ledger remains
  the sole billing and provider-yield authority;
- do not copy provider cost into the carrier and do not query it for V2 round
  accounting;
- retries reuse the same carrier.

This row exists only to satisfy the legacy canonical-candidate foreign key. It
must not be interpreted as proof that V1 discovery ran.

#### 7.4.3 Commercial candidate and inventory compatibility state

Migration 0091 must add only the exact V2 branch needed by the bridge:

- commercial candidate
  `score_model_version = 'recommendation-pool-materialization.v2'`;
- commercial candidate `state = 'v2_materialized'`;
- `static_assessment`, `gate_decision` and `commercial_score` contain closed,
  schema-validated non-scored compatibility payloads with no numeric threshold
  and no `eligible` qualification claim;
- commercial candidate `visible_pool_generation` and context match the V2
  generation and carrier batch;
- inventory starts with `fit_decision = 'unassessed'`,
  `fit_score_model_version = NULL`, and a non-`PUBLISHED` contact state such as
  `CONTACT_PENDING` or `CONTACT_REVIEW`;
- do not relax the old inventory `PUBLISHED` gate globally and do not make V2
  release depend on that field;
- V2 release-batch/item state and user publication facts are the only V2
  visibility/entitlement authority.

The bridge may update contact compatibility fields from real terminal contact
facts where downstream code needs them, but it may not manufacture a verified
email or V1 fit decision.

#### 7.4.4 Staged recommendation authorization and write order

Migration 0091 must add nullable `generation_contract_id`,
`visible_pool_generation`, `input_pin_id`, `pool_contract_version` and
`materialization_contract_version` columns to `backlink_recommendations`.

Rules:

- legacy recommendations keep all five fields null;
- a native V2 recommendation supplies all five fields and uses one composite
  foreign key to `backlink_rec_generation_v2_lineage_uq`;
- `backlink_phase9_can_insert_v2_recommendation` validates those exact fields
  and the V2 materialization contract; it does not require the project contract
  to have rotated to the staged generation;
- the guard rejects partial lineage, a V1 pool contract, an unknown generation,
  or a generation/context/round/input-pin combination assembled from different
  rows;
- the transaction order is: resolve Blueprint, create/reuse carrier, insert V2
  generation candidate, insert/reuse prospect, insert recommendation with
  exact staged lineage, insert inventory, link commercial candidate, create
  release item, complete batch/generation, then atomically rotate the project
  contract;
- retry returns the same canonical identities and cannot create a second
  recommendation for the same prospect/context.

This removes the current active-contract cycle without weakening the Phase 9
V1 freeze.

### 7.5 Release snapshots

Release items must copy the user-visible immutable snapshot needed to render a historical release without recalculating current scores or metrics. Existing batch and item tables may be extended only where required.

Add `generation_candidate_id` to the release item or an equivalent strict
mapping. It is nullable for legacy-imported rows and mandatory for native V2
rows. Preserve the existing candidate/recommendation/prospect/inventory foreign
keys because Opportunity creation depends on them.

### 7.6 Contract-version migration

Migration 0091 must also make the generation identity truthful:

- use `recommendation-pool-admission.v2` as the V2
  `qualification_contract_version`;
- use `recommendation-pool-release-visibility.v2` as the V2
  `visibility_contract_version`;
- use `recommendation-pool-materialization.v2` as the value of the
  legacy-named `score_model_version` column; it identifies the canonical
  materialization contract and carries no numeric score or eligibility meaning;
- use `recommendation-pool-worker.v2` as the V2
  `creator_worker_contract_version`;
- stop new V2 generations from copying
  `recommendation-qualification.v1`;
- replace the V2 use of `recommendation-commercial-fit.v4` with an explicit
  non-scoring materialization contract value;
- preserve V1 rows and V1 validation unchanged;
- update launch, load, guard, query and finalizer code to branch on
  `pool_contract_version` plus the matching contract versions.

Do not globally relax V1 constraints. Every altered check must have a V1 branch
that preserves the existing exact values and a V2 branch that accepts only the
new exact values.

The input pin must migrate by addition, not mutation:

- resolve the current authoritative project/profile/evidence versions;
- create or reuse a new `backlink_generation_input_pins` row whose
  `qualification_contract_version` is `recommendation-pool-admission.v2`;
- include the V2 admission contract and source-version identities in its
  deterministic immutable fingerprint;
- bind the new V2 generation to this V2 pin through the existing composite
  foreign key;
- keep every V1 pin byte-for-byte unchanged;
- update project-context projection and generation-launch validation so each
  pool contract accepts only its matching pin contract.

### 7.7 Migration integration requirements

The same change that adds 0091 must:

- update `backend/database/deployment-manifest.v1.json`;
- change `heads.backlinks` from `0090` to `0091`;
- add `migrationId: backlinks-0091`;
- use prerequisite `backlinks-0090`;
- record the exact normalized-file SHA-256;
- enable and force tenant RLS on every new table;
- add grants, tenant/project indexes and deletion/supersession handling;
- pass the repository migration-manifest checker.

### 7.8 Policy Decision Freeze

Before production behavior is changed, record these values in the existing
versioned V2 domain policy declaration and in the implementation evidence.
Gate 0 may add constants and focused tests, but runtime wiring belongs to the
work package named in the table:

| Decision | Initial value for this fix | Boundary |
| --- | --- | --- |
| Low-yield window | `<5` new unique domains and `<5%` new-unique rate | Provisional `recommendation-discovery-budget.v1`; affects only new generations |
| Contact preparation deadline | 24 hours | Preserve until measured real samples justify a new version |
| Contact poll interval | 15 minutes | Preserve for behavior; instrument separately before tuning |
| Contact retries/backoff/per-site timeout | `maxAttempts=3`; V2 retry delay `30 seconds`; static fetch timeout `12 seconds` per URL; Browser Worker timeout `20 seconds`; `8 minutes` hard activity/attempt ceiling | `maxAttempts`, fetch, browser and activity ceilings match existing defaults. The `30 seconds` retry delay is a new V2 default: current V1 recovery writes `retry_after=now()` and remains unchanged. Gate 7 wires and timing-tests the V2 delay; changing any value requires a new policy version |
| Initial discovery budget | USD 1 per round, USD 2 total | Hard durable authorization ceiling |
| Admitted/effective unique candidate ceiling | 1,000 | Hard full-pool ceiling; this is not a raw provider-row ceiling |
| Raw observation ceiling | `2,500` provider rows per initial generation under `recommendation-discovery-budget.v1`: at most `25` paid requests across both rounds and at most `100` rows per request; each round remains independently capped at USD 1 and the generation at USD 2 | The request cap is the minimum of the versioned `25`-call ceiling, the durable provider grant and the remaining budget divided by authorized estimated request cost. Raw source evidence and duplicates do not consume the 1,000 admitted-domain ceiling |
| Supply target | 100 admitted unique domains | Stop scheduling new paid requests when reached |
| Recommendation marker | `recommendation-marker.v1` | Advisory only; no numeric public score |
| V2 generation versions | admission `recommendation-pool-admission.v2`; visibility `recommendation-pool-release-visibility.v2`; materialization `recommendation-pool-materialization.v2`; worker `recommendation-pool-worker.v2` | Exact allowlist; never copy V1 qualification or commercial-score versions |
| V2 input pin | New immutable snapshot over the same authoritative source versions, with the V2 admission contract in its fingerprint | Never update/relabel or directly reuse the V1 pin |
| Historical domain handling | `ALREADY_RELEASED_TO_PROJECT` or `EXISTING_PROJECT_OPPORTUNITY` before batch selection | Preserve source evidence; never re-release as a new website |
| Archive scope | Actor-scoped | No provider call, refill or canonical batch mutation |
| Long-term paid refill | Out of scope | No implementation until separately specified |

Policy decisions are classified before they can block Gate 0:

1. Product-semantic decisions change admission, visibility, user entitlement,
   budget, release or completion behavior. If the two authoritative documents
   do not determine one of these decisions, Gate 0 is `BLOCKED` and the
   implementation must not silently invent product behavior.
2. Operational-safety decisions bound an already selected product behavior,
   such as a timeout, retry delay, request count or raw-row cap. The task must
   derive these from the existing runtime policy, deployment limits and durable
   budget, freeze them in a versioned policy and add focused tests. A derivable
   operational value is not a reason to request repeated user authorization.
3. A policy blocker must name the unresolved product semantic, the conflicting
   source passages and the exact code path that cannot proceed. `TBD` by itself
   is not a sufficient blocker when the current implementation already provides
   a bounded value.

## 8. Fix Work Packages

Each package has a mandatory exit gate. A package is not complete because code was written.

Gate numbers are stable reference IDs, not the execution sequence. Section 11
is authoritative for execution order. In particular, do not enter Gate 3 merely
because Gate 2 passed: the V2 admission/materialization authority in Gate 4
must exist before discovery breadth or paid concurrency is increased, and the
Temporal-safety part of Gate 7 must precede workflow control-flow changes in
Gate 5.

### Gate 0: Freeze the baseline and establish ownership

**Objective**

Make the current V2 baseline reviewable without cleaning or reverting unrelated work.

**Actions**

- Record Git root, remote, branch, HEAD and full status.
- Create a task ownership ledger for every file this fix may modify.
- Record an explicit owner and SHA-256 for each untracked migration 0080-0090,
  the V2 pool/seed repositories and the modified deployment manifest.
- Treat the current task as the owner of the listed Gate 0 scope when no other
  active task claims an overlapping path and two short-interval hash samples
  are stable. An idle or completed task is evidence history, not a live owner.
- If another active task owns or changes a path, block only the overlapping
  path and dependent work package. Do not block unrelated Gate 0 evidence or
  tests.
- Confirm the current 0080-0090 migration hashes match their manifest entries,
  then establish whether the manifest's broad formatting rewrite is intentional
  and who owns it.
- Create a byte-preserving, repository-external local checkpoint bundle and
  hash manifest for the prerequisite files before edits. This local artifact is
  part of Gate 0 evidence and does not require Git branch/commit/push
  authorization.
- Stop only the dependent work if prerequisite hashes continue changing after
  the ownership claim or if the repository-external checkpoint cannot be
  created and verified. Do not start migration 0091 on a moving prerequisite
  chain.
- Hash the two authoritative documents and all existing V2 migrations.
- Resolve every planned path with `rg --files`; remove stale or guessed paths.
- Run the existing V2 migration tests against the current manifest. Point-
  migration tests must apply only the manifest steps before their own target;
  latest-chain tests may apply through the current head. Replace stale frozen-
  head assertions and invalid migration ordering with manifest-order
  assertions; do not weaken schema, RLS or lineage checks.
- Make historical point-migration runners accept a current manifest head at or
  after their exact target while preserving target path, prerequisite, tool,
  recovery and normalized SHA-256 validation.
- Freeze the policy decisions in section 7.8.
- Declare the Gate 0 values in the existing V2 policy module and lock them with
  focused tests. Do not wire the new raw-observation or retry-delay constants
  into runtime behavior before their assigned work packages.
- Capture the current AWOL failure as a reproducible diagnostic fixture.
- Capture the current hidden prior-V1 Blueprint prerequisite as an expected-red
  regression fixture and lock the deterministic seed-snapshot-to-Blueprint
  transaction contract. Retry and two concurrent confirmations must resolve the
  same exact seed-snapshot fingerprint and never select an unrelated latest-
  active Blueprint; Gate 1 owns the failing contract test and Gate 2 owns the
  production implementation.
- Inventory open `recommendation-pool-v2` Temporal workflow IDs, run IDs,
  current events and worker build ID.
- Lock the proposed V2 candidate, compatibility carrier, input-pin, historical-
  domain and staged-generation transaction contracts in sections 7.2-7.7.
  Gate 1 converts these contracts into expected-red repository/database tests;
  Gate 2 adds migration 0091 and makes them pass. Do not build a second,
  test-only copy of migration 0091 in Gate 0.
- Obtain explicit authorization before creating a Git branch or commit, pushing,
  deploying, calling a paid provider or performing non-rollback business-data
  writes. A repository-external local checkpoint bundle is already authorized
  by an instruction to execute Gate 0 unless the user explicitly forbids local
  artifacts.
- Do not start schema or service edits while another task owns the same files.

**Exit gate**

- Every planned file has one owner.
- The exact 0080-0090 prerequisite hashes and matching manifest entries are
  stable and reproducible before 0091 is created.
- The deployment-manifest formatting owner is explicit; the 0091 patch does not
  absorb or overwrite unrelated manifest churn.
- Existing user changes are preserved.
- The pre-fix failing business chain is reproducible from evidence.
- All policy decisions required by this fix are frozen and versioned.
- The canonical materialization transaction and schema shape are locked as
  explicit Gate 1/2 contracts; fake V4 scores and disabled constraints are not
  accepted.
- The current no-prior-V1 seed-confirmation failure is reproducible, and the
  seed-exact retry/concurrency behavior is assigned to an expected-red Gate 1
  test. Current production behavior is expected to remain red until Gate 2.
- Compatibility carrier, composite lineage, non-`PUBLISHED` inventory, immutable
  V2 input pin, historical-domain classification and staged-generation
  authorization each have one unambiguous Gate 1 test contract and Gate 2
  production exit condition.
- Point-migration tests and runners remain usable after later append-only
  migrations are added, without weakening exact target hash or prerequisite
  checks.
- The Temporal upgrade strategy is selected for all currently open histories.
- Gate 0 may pass while the Gate 1 product-contract tests remain red for their
  documented current reasons. Production satisfaction of these contracts is a
  Gate 2 exit condition, not a Gate 0 prerequisite.

**Anti-stall rule**

- Historical instructions that named a different `Stage 0` as strictly
  read-only do not silently redefine this Gate 0. This gate explicitly permits
  its listed local evidence artifacts and rollback-only tests.
- Missing authorization for commit/push/deployment/provider calls cannot block
  local hashes, repository-external checkpoints, diagnostics or locally
  authorized test/tool maintenance.
- Gate 0 must not require production behavior that only migration 0091 can
  provide. Such behavior is an expected-red Gate 1 contract and a Gate 2 exit
  condition.
- Before returning `BLOCKED`, the executor must attempt every non-conflicting,
  locally authorized Gate 0 action and report only the smallest remaining
  dependency boundary.

### Gate 1: Add failing product-contract tests

**Objective**

Turn the two authoritative documents into executable red tests before changing production semantics.

**Required tests**

- A relevant candidate with unknown SEO metrics is admitted.
- A relevant candidate below the V1 score threshold is admitted.
- A relevant candidate with no contact details is admitted and queued for enrichment.
- Only an allowed hard-exclusion code can exclude a candidate.
- A new V2 generation persists
  `recommendation-pool-admission.v2`, not a V1 qualification version.
- A new V2 generation references a V2 input pin with the same authoritative
  source-version lineage; the historical V1 pin is unchanged.
- Project-context projection accepts only the exact pin contract matching the
  selected pool contract.
- A V2 admitted candidate materializes canonical IDs without any V1 eligible
  score or qualification fact.
- The same materialization uses a deterministic V2 compatibility batch and a
  non-`PUBLISHED` inventory row.
- A project with no prior commercial Blueprint can confirm seeds and launch V2
  without invoking V1 discovery.
- A native V2 release item has both `generation_candidate_id` and the existing
  canonical candidate/recommendation/prospect/inventory lineage.
- One to 99 admitted candidates publish as `PARTIAL_EXHAUSTED`.
- Missing seeds return `INPUT_REQUIRED` before any provider call.
- Provider/system failure returns `FAILED`.
- A successful zero-valid result is not reported as a score-qualification failure.
- A second round must change a real recorded discovery dimension.
- Multiple request paths can run in one round without duplicate provider intents.
- Every paid request has its own authorization, reservation, intent, outcome
  and replay identity.
- Get More performs zero provider calls.
- Historical releases remain visible after a new generation or input-pin change.
- A domain already present in a project release or Opportunity is not admitted
  to a new batch, and its new discovery evidence is retained.
- Two concurrent generation attempts cannot release the same canonical domain.
- The running or failed generation is visible while the prior published pool remains usable.
- The generate UI cannot launch until the prepared seed set is confirmed.
- A completed generation is never mutated to repair an old failure; a fresh
  higher generation is created and rotated.
- A staged same-context and a staged changed-context V2 generation both satisfy
  Phase 9 write guards through exact recommendation lineage before project
  rotation, without changing V1 history.
- A recommendation with partial, mismatched or V1 lineage is rejected by the
  same Phase 9 guard.
- Captured Temporal histories replay successfully against the new workflow
  bundle or are isolated by an explicit patch/new workflow type.

**Primary files**

- `backend/core/test/unit/recommendation-pool-v2-dataforseo-executor.test.ts`
- `backend/core/test/unit/recommendation-pool-v2-workflow.test.ts`
- `backend/core/test/backlinks/unit/recommendation-pool-v2-discovery-finalizer.service.test.ts`
- new V2 admission and feed repository unit/integration tests
- `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.test.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-feed-api.test.ts`

**Exit gate**

The new tests fail for the documented current reasons, not because of fixture or environment errors.

### Gate 2: Introduce the V2 candidate authority

**Objective**

Make the V2 candidate tables authoritative without mutating V1 history.

**Actions**

- Add migration 0091 and generated types.
- Add the V2 contract-version branch described in section 7.6.
- Add deterministic creation/reuse of a V2 input pin and bind every new V2
  generation to that pin.
- Make seed confirmation create or resolve the existing commercial Blueprint
  model for the current context; remove the hidden prior-V1-run prerequisite.
- Replace the hard-coded V1-only input-pin validation with an exact
  pool-contract-to-pin-contract allowlist.
- Add repository methods to insert immutable canonical candidates and append source evidence.
- Make candidate identity project- and generation-scoped.
- Add hard-exclusion validation and database constraints.
- Add the project-domain registry lookup over release and Opportunity facts;
  preserve the existing project-domain uniqueness constraint as a race guard.
- Persist metric snapshots independently from admission.
- Add the idempotent V2-to-canonical materialization link.
- Add the explicit V2 compatibility discovery-batch carrier and exact
  commercial-candidate materialization state/version from section 7.4.
- Add the carrier's full generation-lineage composite foreign key, including
  the input pin; do not implement separate weaker references.
- Add exact V2 lineage fields to new recommendation rows and replace the
  active-project-only Phase 9 insert exception with the staged-lineage
  authorization from section 7.4.4.
- Keep compatibility inventory non-`PUBLISHED`; do not relax the V1 inventory
  publication gate.
- Extend release items with native V2 candidate lineage while preserving the
  existing canonical foreign keys.
- Update Phase 9 guards so a valid staged V2 generation can create canonical
  recommendation/inventory rows before atomic project-contract rotation.
- Update the deployment manifest in the same patch and verify its SHA-256.
- Backfill only active V2 generations where lineage is complete and deterministic.
- Mark incomplete lineage as migration-blocked; do not synthesize evidence.

**Primary files**

- `backend/core/src/modules/backlinks/db/migrations/0091_backlink_recommendation_pool_v2_candidate_facts.sql`
- `backend/database/deployment-manifest.v1.json`
- generated database types and clients
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts`
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.ts`
- `backend/core/src/modules/backlinks/db/repositories/project-input-persistence.repository.ts`
- `backend/core/src/modules/backlinks/application/commands/project-context-projection.command.ts`
- new focused V2 candidate repository/service modules if needed

**Exit gate**

- V2 admitted count is computed only from V2 candidate facts.
- V1 score/state changes cannot alter V2 admitted count.
- New V2 generations contain no V1 qualification or V1 score contract version.
- Every new V2 generation references an immutable V2 input pin; no V1 pin was
  updated or relabelled.
- Canonical materialization contains no fabricated V1 eligible score or
  qualification evidence.
- A fresh project can create/resolve its Blueprint and complete V2
  materialization without a V1 discovery run.
- Every compatibility candidate references one deterministic V2 carrier batch;
  the carrier contributes zero provider cost/yield facts and its full lineage
  resolves to one generation row.
- A staged recommendation is accepted only with complete V2 lineage; partial,
  cross-generation or V1 lineage remains blocked.
- V2 batch availability does not require the compatibility inventory
  `publication_status` to become `PUBLISHED`.
- Historical release/Opportunity domains are excluded before batch creation,
  and concurrent duplicates are rejected atomically.
- A staged generation passes Phase 9 guards and can rotate only after immutable
  completion and batch availability.
- Migration check, rollback policy check and tenant-isolation tests pass.
- Deployment manifest head is `0091`, its prerequisite is `backlinks-0090`, and
  the stored checksum matches the migration.
- `MIGRATION_BLOCKED` project count is zero for projects claimed ready.

### Gate 3: Repair discovery planning and bounded execution

**Objective**

Use the existing provider safely while actually exercising diverse discovery paths.

**Actions**

- Replace subject-first flat slicing with a deterministic fair planner.
- Interleave subject, category, competitor, pattern and market/language dimensions.
- Replace the single-request round result with a collection of per-request
  results. Do not change `maxRequests: 1` until this contract, validation and
  persistence change exists.
- Permit multiple request intents per round while preserving:
  - round 1 cost at or below USD 1;
  - round 2 cost at or below USD 1;
  - total cost at or below USD 2;
  - maximum 1,000 admitted/effective unique candidate domains in the pool;
  - raw observations remain bounded separately by per-request provider limits, request count and durable USD authorization;
  - immediate stop when 100 admitted candidates exist.
- Persist a request intent before provider execution.
- Authorize and reserve every request separately; enforce both request-level
  and cumulative round/initial-pool ceilings.
- Reuse an existing request outcome on retry instead of billing again.
- Return exact V2 counts from candidate ingestion:
  `raw`, `canonicalDeduped`, `newUnique`, `duplicate`, `admitted` and
  `hardExcluded`.
- Stop deriving `newUnique` from the before/after count of V1 materialized or
  published candidates.
- Record the exact changed dimension between rounds.
- Make request concurrency configurable only through the existing bounded runtime mechanism; do not introduce an unbounded fan-out.

**Primary files**

- `backend/core/src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts`
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2-discovery-ledger.repository.ts`
- discovery request/round repositories and focused tests

**Exit gate**

- A fixture with multiple seeds produces a balanced, deterministic request plan.
- Duplicate request fingerprints are not billed twice.
- Every settled/replayed request can be reconciled independently.
- Window yield is based on V2 `newUnique`, not V1 scored/materialized count.
- Both cost ceilings are enforced by durable ledger facts.
- A round cannot claim `KEYWORD` changed when the keyword fingerprint is unchanged.

### Gate 4: Separate admission, metrics, contact and recommendation

**Objective**

Implement the V2 product semantics instead of adapting the V1 score decision.

**Actions**

- Add one admission service whose output is only admitted or an allowed hard-exclusion code.
- Make the admission service consume normalized V2 source evidence and the
  immutable V2 admission-policy snapshot.
- Make admission consult the project-domain registry before returning
  `ADMITTED`.
- Remove `commercialScore.decision === "eligible"` from V2 ranking and materialization.
- Remove V1 score model/version from V2 candidate counting.
- Treat metrics as nullable annotations.
- Start contact enrichment only after admission.
- Preserve candidates when contact enrichment returns no contact, unsupported, timed out or failed.
- Derive the recommended marker from explainable signals without publishing a numeric score.
- Materialize the existing commercial-candidate/prospect/recommendation/
  inventory identities through the explicit V2 bridge.
- Use the V2 compatibility carrier for required legacy Blueprint/batch foreign
  keys; never run V1 discovery as a bridge prerequisite.
- Keep the compatibility inventory outside the V1 `PUBLISHED` state; V2 release
  facts control visibility.
- Keep V1 commercial score as historical/advisory migration evidence only.
- Do not alter the V1 discovery, qualification or publication semantics for
  preserved V1 rows.

**Primary files**

- V2 admission service and tests
- V2 canonical materialization service and tests
- `backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts`
- `backend/core/src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts`
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts`

**Exit gate**

- Low, unknown and unavailable metrics cannot exclude an otherwise valid candidate.
- Contact status cannot exclude an otherwise valid candidate.
- Every excluded candidate has one allowed hard-exclusion fact with evidence.
- Repeated provider observations within a generation append evidence, while
  historical project domains receive an explicit release/Opportunity exclusion.
- Every admitted native V2 candidate selected for release has one idempotent
  canonical materialization link.
- Each link resolves one V2 compatibility batch/candidate chain and one
  non-`PUBLISHED` inventory row without fabricated fit or email facts.
- No V2 path calls `applyProgressiveCommercialCandidateAdmission`, requires a
  V4 eligible qualification fact, or parses an applied score threshold.
- The public API still contains no numeric recommendation score.

### Gate 5: Correct completion, batch and terminal semantics

**Objective**

Publish the usable result and report the actual reason generation stopped.

**Required state rules**

| Condition | Required outcome |
| --- | --- |
| Seeds missing or invalid before discovery | `INPUT_REQUIRED`, zero provider calls |
| Provider/internal error | `FAILED` with durable retryable/non-retryable reason |
| 100 admitted candidates | Prepare/publish full batch and `READY` or `UNLOCKED` |
| 1 to 99 admitted after bounded exhaustion | Prepare/publish available candidates and `PARTIAL_EXHAUSTED` |
| 0 valid after all paths and hard exclusions | Explicit `NO_VALID_CANDIDATES_AFTER_EXHAUSTION`; not a score failure and not silently replaced by an old pool |
| All prepared/released candidates consumed | `POOL_EXHAUSTED` |

Persist separate operational and product projections:

- job execution: queued, running, waiting, succeeded or failed;
- discovery result: target reached, partial exhausted, no valid candidates,
  budget exhausted, paths exhausted or provider/internal failure;
- contact preparation: pending, completed, partial or deadline reached;
- release result: no batch, preparing, available or exhausted.

A successful zero-valid discovery may complete its operational job
successfully while exposing `NO_VALID_CANDIDATES_AFTER_EXHAUSTION` as the
product outcome. Do not overload `INPUT_REQUIRED` unless user input is actually
required.

The existing completed/failed generation is immutable. Acceptance after this
fix must create a fresh higher V2 generation, complete it once, make its first
batch available, and then rotate the project contract atomically. Do not update
the old generation to make the sample appear repaired.

**Primary files**

- `backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-workflow.service.ts`
- `backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-discovery-finalizer.service.ts`
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts`
- release and status routes/contracts

**Exit gate**

- The AWOL diagnostic fixture no longer fails because of the V1 score threshold.
- A 1-to-99 fixture creates a canonical release batch.
- Terminal state, terminal reason, admitted count and released count agree.
- Provider success plus zero valid candidates is not stored as job failure or
  `INPUT_REQUIRED`.
- The previously failed generation remains unchanged; the replacement is a
  higher generation with independent immutable facts.

### Gate 6: Repair feed entitlement and seed lifecycle UX

**Objective**

Make the current recommendation-pool panel operate the V2 lifecycle truthfully.

**Backend actions**

- Build the feed from all release items entitled to the user across historical publications.
- Apply archive, permanent exclusion, filters, search, sort and cursor server-side.
- Return two separate projections:
  - released pool currently available to the user;
  - latest generation state, progress, counts and terminal reason.
- Split seed preparation/preview from seed confirmation and generation launch.
- Require an idempotency key and a confirmed seed snapshot for launch.
- Update the Core schema and OpenAPI source first, then the Python gateway,
  gateway tests and generated frontend client. Do not hand-edit generated
  client output.

**Frontend actions**

- Present generated keyword, category and SEO-competitor seeds for review.
- Allow add, remove and edit before confirmation.
- Poll the generation projection while the job is non-terminal.
- Keep the previous released pool usable during a new build, but label its generation separately.
- Show `PARTIAL_EXHAUSTED`, empty, failed and input-required outcomes with their true reason.
- Stop polling on a terminal state and allow retry only when the backend says it is safe.

**Primary files**

- `backend/core/src/modules/backlinks/db/repositories/recommendation-feed.repository.ts`
- `backend/core/src/modules/backlinks/api/recommendation-feed.route.ts`
- `backend/core/src/modules/backlinks/api/recommendation-seeds.route.ts`
- `backend/api/app/api/routes/backlinks.py`
- `backend/api/tests/test_backlinks_gateway.py`
- Core/OpenAPI source contracts
- `frontend/src/api/generated/backlinks.ts` regenerated from the source contract
- `frontend/src/features/outreach/recommendations/recommendation-feed-api.ts`
- `frontend/src/features/outreach/recommendations/use-recommendation-feed.ts`
- `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.tsx`

**Exit gate**

- A historical released site remains visible after a later generation changes the current input pin.
- The UI shows both the old usable release and the new generation state without conflating them.
- Generate cannot send an implicit empty seed set.
- Core, gateway, OpenAPI and generated-client response shapes agree.
- Desktop, mobile and keyboard accessibility workflows pass.

### Gate 7: Instrument and remove unexplained latency

**Objective**

Measure every material wait before tuning concurrency or timeout behavior.

**Required durable spans**

- command accepted;
- workflow scheduled;
- workflow started;
- seed snapshot loaded;
- request plan created;
- provider request queued, started and completed;
- provider outcome persisted;
- candidate normalization started/completed;
- admission started/completed;
- metric enrichment started/completed;
- contact enrichment started/completed;
- batch prepared;
- publication committed;
- frontend first observed each state.

**Actions**

- Add correlation by command, generation, round, request intent and candidate.
- Distinguish queue time, provider time, retry/backoff, persistence, enrichment and polling delay.
- Emit a timing summary in the implementation evidence document.
- After measurement, fix the actual longest controllable span.
- Do not hide latency by increasing a frontend timeout or marking work complete early.
- Keep four user-relevant latency measures separate:
  - time to discovery terminal;
  - time to candidate pool persisted;
  - time to batch `PREPARING`;
  - time to first visible `AVAILABLE` batch.

**Temporal upgrade safety**

- Capture histories for every open `recommendation-pool-v2` workflow before
  changing workflow code.
- Add workflow replay tests for the captured histories.
- Use Temporal `patched`/deprecation markers, a new workflow type, or an
  approved worker-version rollout for nondeterministic control-flow changes.
- Update activity registration/composition before starting the new worker.
- Build the worker, restart it with a new `TEMPORAL_BUILD_ID`, and verify the
  expected task-queue poller before launching a fresh generation.
- Do not treat `buildId` as protection by itself while `useVersioning` remains
  false.

**Initial performance gates**

- Local command acknowledgement: at most 2 seconds.
- Healthy local worker start after scheduling: at most 10 seconds.
- No unexplained interval greater than 10 seconds.
- Provider duration and product-controlled duration are reported separately.
- Final end-to-end targets are set only after two instrumented real samples establish a valid baseline.

**Exit gate**

Every second of the real-sample timeline is assigned to a named span, and the largest product-controlled delay has either been removed or documented as blocked with evidence.

All captured workflow histories replay successfully or are isolated from the
new implementation by an explicit, tested version boundary.

### Gate 8: Full local verification

**Objective**

Prove the product chain and adjacent regressions before any paid acceptance run.

**Backend commands**

```powershell
cd C:\Users\DELL\Documents\缝合\john3947-seo-main\backend\core
npm run typecheck
npm run lint
npm run openapi:backlinks:check
npm run migration:backlinks:check
npm run test:backlinks:unit
npm run test:backlinks:api
npm run test:backlinks:contract
npm run test:backlinks:integration
npm run test:backlinks:security
npm run test:backlinks:resilience
npm run verify:backlinks
npm run test:backlinks:e2e
```

**Python gateway command**

```powershell
cd C:\Users\DELL\Documents\缝合\john3947-seo-main\backend\api
python -m pytest tests/test_backlinks_gateway.py
```

**Frontend commands**

```powershell
cd C:\Users\DELL\Documents\缝合\john3947-seo-main\frontend
npm run typecheck
npm run lint
npm run check:backlinks-client
npm run check:backlinks-v2-contract
npm run test
npm run test:e2e:desktop
npm run test:e2e:mobile
npm run test:e2e:keyboard-a11y
npm run build
```

**Runtime verification**

- Start the approved local stack only.
- Replay captured Temporal histories before starting the replacement worker.
- Verify the replacement worker's `TEMPORAL_BUILD_ID`, task queue and active
  poller after restart.
- Verify project-scoped generation through the same API and UI path used by the recommendation-pool panel.
- Inspect durable seed, request, provider ledger, candidate, metric, contact, batch, publication and user-feed facts.
- Verify V1 active generation, refill and provider writes remain zero.
- Verify Get More changes only user release state and creates zero provider ledger rows.
- Verify the downstream fake-provider outreach chain remains operational.

**Exit gate**

All required commands pass from the recorded HEAD/worktree, captured histories
replay successfully, the intended worker is polling, and the local
UI/API/database evidence describes the same generation.

### Gate 9: Bounded real-provider acceptance

**Objective**

Prove that two unrelated, viable website projects can use the complete native
V2 Backlinks product path:

```text
project inputs
-> confirmed V2 seed snapshot
-> bounded V2 discovery
-> native V2 candidate
-> canonical V2 batch and user publication
-> released feed and recommendation UI
-> canonical Opportunity
-> Draft/contact-review downstream gate
```

The acceptance path must not read from, write to or fall back to the V1
recommendation implementation.

**Authorization boundary**

- Requires explicit user authorization before paid calls.
- DataForSEO ceiling: at most USD 2 per project and at most USD 4 total.
- Gmail calls: zero.
- Deployment: none.
- No manufactured candidates, manual SQL inserts or fixture substitution.

**Samples**

1. Re-run the AWOL project after the fix.
2. Select a second unrelated project with valid project inputs and no shared
   recommendation lineage. The second sample must be a newly created project
   or must prove that it has no dependency on a historical V1 recommendation
   generation, V1 qualification contract or V1 commercial Blueprint authority.

**Required evidence per sample**

- confirmed seed snapshot;
- all request intents, dimensions and fingerprints;
- provider request count, duration and cost;
- raw, unique, admitted, hard-excluded, metric-enriched and contact-enriched counts;
- every exclusion code and evidence;
- prepared and released batches;
- GET/feed projection;
- desktop/mobile UI screenshot;
- Opportunity creation through `recommendationFeedItemId`, including canonical
  domain uniqueness, actor entitlement and V2 lineage evidence;
- downstream evidence for both allowed terminal outcomes:
  - a real terminal contact snapshot may proceed to the existing Draft
    evidence path;
  - a no-email terminal snapshot creates or preserves
    `contact_review_required`, while Draft and Send remain fail-closed;
- timing report containing discovery terminal, candidate persisted, batch
  preparing and first visible timestamps;
- durable workflow ID, run ID, job ID, generation ID and worker build ID;
- before/after V1 side-effect queries covering generation, refill, job, outbox,
  claim, reservation, lease and Provider request facts;
- proof that the same project would fail closed rather than invoke a V1
  fallback if a V2 generation cannot proceed.

**Acceptance rule**

For each intentionally viable sample, at least one native V2 candidate must be
admitted and released. A `legacy_imported` candidate or a release reconstructed
from V1 recommendation authority does not satisfy this rule.

At least one sample must complete the V2 feed-to-Opportunity transaction. The
two samples together must prove both the normal Draft path and the no-email
fail-closed path, without a real Gmail send.

If a sample produces zero, do not alter or invent data to pass: report
`BLOCKED`, preserve provider evidence, and determine whether the cause is seed
quality, discovery coverage, provider yield, hard exclusion or a remaining
implementation defect.

The paid acceptance session may finish discovery while contact preparation is
still legitimately waiting. In that case:

- record the durable IDs and current facts;
- report `REAL_PROVIDER_DISCOVERY_COMPLETE`,
  `BATCH_PREPARING`, or the exact current state;
- resume verification from durable state later;
- do not label `SAMPLE_ACCEPTANCE` complete until a batch is `AVAILABLE` and
  the same API/UI path renders it;
- do not shorten the 24-hour deadline or inject terminal contact facts merely
  to finish the session.

**Exit gate**

Both projects eventually complete through the same production API/UI path,
within the paid ceiling, with native V2 lineage, verified worker identity and
zero V1 recommendation-side writes. At least one native V2 feed item reaches
the canonical Opportunity path, and downstream Draft/contact-review behavior
matches its real terminal contact evidence.

The second sample proves that a project can start directly on V2 without a V1
recommendation authority. An interactive session ending before the contact
deadline is not itself a failure, but it is not final sample acceptance.

### Gate 10: V2-only cutover and V1 recommendation-pool decommission

**Objective**

Make V2 the only production recommendation-pool implementation, remove the V1
recommendation implementation from every executable production control path,
preserve required historical facts as immutable audit evidence, and verify the
complete Backlinks workflow on the final runtime build.

This gate is implementation and verification work, not a decision-only review.

**Required production retirement**

- unregister all V1 recommendation write routes and remove their generated
  write-client surface;
- remove the V1 recommendation/refill Workflow from the production Worker
  bundle and production workflow namespace;
- stop constructing or registering V1 recommendation relay, consumer,
  activity, periodic refill, project-analysis refill, recovery, reservation,
  lease and Provider execution paths;
- remove the legacy V1 recommendation workspace from production frontend
  composition so the V2 feed is the only recommendation-pool UI;
- remove V1 fallback selection from V2 admission, batching, publication,
  Opportunity and Draft selection;
- make new-project initialization select the V2 contract directly and prevent
  creation of a new V1 recommendation generation;
- retain database freeze/contract guards as defense in depth after the
  production call edges are removed;
- use forward-only cleanup migrations, when required, to drop obsolete V1
  recommendation functions, triggers, queues or writable schema objects only
  after a reference scan proves they are not needed for historical reads;
- where historical V1 rows are still needed, revoke product writes and expose
  them only through explicitly read-only audit/report compatibility paths.

**Mandatory invariants**

- all eligible existing projects use `recommendation-pool.v2`
- every newly created Backlinks project initializes with
  `recommendation-pool.v2`
- `active V1 generation = 0`
- executable V1 recommendation API write routes = 0
- V1 recommendation Workflows in the production Worker bundle = 0
- registered V1 recommendation activities, relays, consumers, periodic jobs,
  recovery scans and Provider call edges = 0
- new V1 generation/refill/job/outbox/claim/reservation/lease/provider writes
  are rejected by database constraints even if a stale caller attempts them
- `MIGRATION_BLOCKED project = 0`
- no V1 score dependency in V2 admission/count/publication
- no new V2 generation pinned to a V1 qualification or score contract version
- no new V2 generation bound to a V1 input pin
- no candidate without source lineage
- no excluded candidate without an allowed hard-exclusion fact
- no native V2 release item without both V2 generation-candidate lineage and
  canonical downstream identities
- no V2 canonical candidate whose required discovery batch lacks an explicit
  V2 generation/materialization contract
- no V2 provider cost, yield or round accounting sourced from a compatibility
  discovery batch
- no V2 release entitlement derived from legacy inventory
  `publication_status = 'PUBLISHED'`
- no released item outside a canonical batch
- no canonical domain released more than once per project
- Get More provider calls = 0
- the old V1 recommendation workspace has zero production imports
- V2 feed-to-Opportunity uses `recommendationFeedItemId` and the canonical
  Opportunity transaction
- V2 Draft selection and evidence remain unchanged when V1 score,
  recommendation and legacy publication data are absent or contradictory
- no-email V2 Opportunities remain `contact_review_required`; Draft and Send
  fail closed without fabricating a recipient
- Reply, Placement and Reports continue from the canonical Opportunity without
  treating a recommendation cursor or V1 recommendation row as business truth
- historical released entitlement and downstream business evidence remain
  queryable through read-only paths
- historical V1 facts cannot be updated, reactivated or used to restore V1
  recommendation writes
- deployment manifest Backlinks head/checksum/prerequisite are valid
- captured Temporal histories replay and the intended worker build is polling
- real-provider acceptance passes for both samples
- full desktop, mobile and keyboard E2E pass
- final static call-graph scans find no V1 recommendation production entrypoint
- final runtime observation finds zero V1 recommendation writes and zero
  unexpected Provider calls

**Decision**

- `V2_ONLY_READY`: all gates pass, V2 is the sole production
  recommendation-pool implementation and evidence is attached.
- `BLOCKED`: name the exact failed invariant and preserve the last truthful product state.
- `NOT DEPLOYED`: remains the status until deployment is separately authorized and verified.

## 9. Expected File Scope

The implementation should remain concentrated in:

- forward-only V2 and Gate 10 cleanup migrations, deployment manifest and
  generated database types;
- V2 contract-version, candidate/admission and canonical-materialization repository/service code;
- V2 DataForSEO executor and discovery planner;
- V2 workflow/finalizer/status projection and Temporal replay/worker integration;
- production route composition, Worker workflow definitions/namespaces and
  runtime registrations required to remove V1 recommendation control paths;
- recommendation feed and seed Core routes plus Python gateway;
- OpenAPI and regenerated frontend client;
- recommendation-pool frontend workspace, hook and API client;
- V1 recommendation/refill/frontend source that Gate 10 proves is unreferenced
  and removes;
- focused unit, contract, integration and E2E tests;
- one implementation evidence document.

V1 recommendation-pool decommission is explicitly in Gate 10 scope. Unrelated
formatting, broad refactors, non-recommendation legacy cleanup and other product
modules remain out of scope.

## 10. Definition of Done

This fix is complete only when all statements below are proven:

1. The recommendation-pool panel creates a confirmed V2 seed snapshot and launches one idempotent V2 generation.
2. Discovery uses multiple meaningful, deduplicated paths within the two-round USD 2 ceiling.
3. A canonical V2 candidate fact, not V1 scoring, controls admission and publication.
4. New V2 generations persist an explicit V2 admission contract and no V1
   qualification/score contract identity.
5. Every new V2 generation uses a new or deterministically reused immutable V2
   input pin over the authoritative source versions; V1 pins remain unchanged.
6. Metrics and contact data are nullable enrichment facts, never standalone exclusion gates.
7. Canonical Opportunity/outreach identities are materialized without a fake
   V1 eligible score or qualification fact.
8. A project with no prior V1 commercial Blueprint can confirm seeds and start
   V2; required Blueprint and commercial discovery-batch rows are explicit
   compatibility lineage only.
9. Compatibility inventory remains non-`PUBLISHED`; V2 release facts alone
   control V2 visibility and entitlement.
10. Historical release and Opportunity domains retain evidence but cannot be
   released again as new websites.
11. One to 99 valid candidates are published as a usable partial result.
12. The current generation state is visible without hiding the previous usable release.
13. Historically released websites remain available to the entitled user.
14. Get More performs zero provider calls.
15. All eligible current and future Backlinks projects use V2, and no new V1
    recommendation contract or generation can be created.
16. Production registers no V1 recommendation write route, Workflow, activity,
    relay, consumer, periodic refill, recovery, reservation or Provider call
    edge.
17. The V2 feed is the only recommendation-pool UI and API authority.
18. Native V2 feed items create canonical Opportunities through
    `recommendationFeedItemId`; Draft, Send, Reply, Placement and Reports
    continue without a V1 score or recommendation row as authority.
19. Historical V1 business facts required for audit and existing downstream
    history are immutable and unreachable from recommendation write/control
    paths.
20. Migration manifest, Temporal replay, worker identity, Core/gateway/client
    contracts and full local tests pass on the final V2-only runtime build.
21. Two bounded real-provider samples eventually pass with durable timing,
    lineage, Opportunity and downstream-gate evidence.
22. Deployment and human UAT are reported separately and are never implied.

## 11. Immediate Implementation Order

The first coding change must not be another workflow patch. Execute in this order:

1. Gate 0 ownership/checkpoint, policy freeze, active Temporal inventory,
   current-failure fixtures, locked V2 schema/transaction contracts, and
   forward-compatible point-migration tests/runners.
2. Gate 1 red product-contract tests for Blueprint concurrency, immutable V2
   input pin, candidate authority, compatibility carrier, historical-domain
   race handling, staged lineage guards and Temporal replay.
3. Gate 2 migration 0091: V2 contract identity, immutable V2 input pin,
   candidate facts, project-domain registry, canonical bridge, release lineage,
   Phase 9 guard and deployment manifest.
4. Gate 4 V2 admission and canonical materialization services.
5. Gate 3 per-request ledger/result model, then the fair discovery planner and
   bounded concurrency.
6. Gate 7 Temporal-safety subgate and durable timing instrumentation.
7. Gate 5 terminal, low-yield, immutable generation and atomic rotation semantics.
8. Gate 6 Core route, Python gateway, OpenAPI, regenerated client and UI lifecycle.
9. Gate 8 full local verification.
10. Gate 9 bounded real-provider acceptance, allowing durable continuation
    through the contact deadline.
11. Gate 10 V2-only production cutover, V1 recommendation-pool decommission,
    final runtime observation and publication decision.

This order prevents another nominally complete V2 shell from being built on top
of the same V1 candidate-authority defect and prevents a guard-only cutover
from being mistaken for a V2-only recommendation product.
