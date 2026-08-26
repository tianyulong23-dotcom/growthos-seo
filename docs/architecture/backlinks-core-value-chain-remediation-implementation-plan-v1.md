# Backlinks Core Value Chain Remediation Implementation Plan V1

> Effective date: `2026-08-15`
>
> Status: `PHASE_10_INPUT_REQUIRED`
>
> Product authority:
> `docs/architecture/backlinks-core-value-chain-remediation-v1.md`
>
> Mainline compatibility authority:
> `docs/architecture/backlinks-main-integration-compatibility-audit-v1.md`
>
> Coding entry:
> `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`
>
> Target implementation baseline:
> `C:\Users\DELL\Documents\缝合\john3947-seo-main`, branch `main`, commit
> `2092d0da79cf8b126421369a9ca9db7fd4acd503`
>
> Current phase: Phase 10 real-business UAT is active. Recommendation-supply
> defects found by the UAT are being remediated without opening a new phase.
> CP11 through CP14 remain input-required until a real recommendation can
> progress into a real Opportunity and reply thread.

## 1. Purpose And Boundaries

This plan converts the approved product baseline into isolated vertical
changes. It is designed to avoid partially changing recommendation discovery,
AI draft generation, Gmail readiness, and send synchronization at the same
time.

The completed Phase 0 authorization did not include business-code
implementation, database migration execution, DataForSEO calls, Gmail
authorization changes, or Gmail send. Historical
`WEBSITE-PROJECT-V3-E2E-001` checkpoint state remains unchanged, and CP4
through CP7 remain locked until separately authorized.
`WEBSITE-PROJECT-V3-E2E-002` is a historical, incomplete evidence record with
status `SUPERSEDED_DO_NOT_EXECUTE`; it is not the active execution path and
MUST NOT be resumed by this plan.

The target implementation repository is the integrated `main` worktree, not
the legacy `外链ver` worktree where this plan was authored. Sequence control is
now satisfied by the original M1A result plus its accepted input-resolution
record, M1B `PASS`, and M1C `PASS`; the original M1A result remains
`INPUT_REQUIRED` and is not retroactively rewritten. Phase 0 is `PASS`.
Phase 1 was authorized by the user's `继续下一步` instruction on `2026-08-15`
and is now `PASS`. Phase 2 was authorized by a later `继续下一步` instruction
on `2026-08-15` and is now `PASS`. Phase 3 was authorized by a subsequent
`继续下一步` instruction on `2026-08-15`. Its foundation is `IMPLEMENTED` and
`TESTED`. Its four historical assertion blockers were resolved by the
authorized `2026-08-16` gate recovery. Its two missing credential importers
were then separately authorized, restored, and verified. Its exact result
is now `PASS`. The three subsequent Integration failures were separately
authorized and resolved. The missing formal Resilience runbook was then
separately authorized and restored from a clean committed source. The complete
repository Backlinks gate passes. Phase 4 was authorized by the user's
`继续` instruction on `2026-08-16`. Its V3.2 implementation, migration, and
complete serialized verification pass; its non-empty live qualification
remains `INPUT_REQUIRED` because the current project has no candidate carrying
complete V3.2 critical evidence. Phase 5 and every later phase require a new
exact authorization.

Each phase MUST:

1. own a narrow file set and one product behavior;
2. start from a clean review of current code and tests;
3. add or update tests before claiming the behavior;
4. stop at its listed exit criterion;
5. label code, build, runtime, provider, Gmail, and UAT evidence separately.

## 2. Confirmed Repository Constraints

The following constraints were verified against the local repository and must
be treated as design inputs, not implementation surprises:

Items below are the pre-M1 audit snapshot. Where a later M1 result or the
compatibility audit's current reconciliation section records a newer fact,
that newer exact result wins. These historical constraints are not evidence
that an old task remains executable.

1. The current refill Workflow has an unbounded `while (true)` coordinator and
   a provider Activity timeout of two hours.
2. Current commercial discovery uses provider concurrency `1`,
   `CACHE_PREFERRED`, the legacy `recommendation-commercial-fit.v3` scorer,
   and a contact-ready publication count.
3. Migration `0054` and later SQL constraints allow only the legacy score
   models and require public-email contact evidence for `PUBLISHED`.
4. Migration `0060`, refill reservation, reconciliation, contact enrichment,
   runtime persistence, and recommendation queries all count the same
   contact-ready definition. Changing only the publication service or one
   query would create a mixed contract.
5. The existing generic-looking bulk service is actually specific to
   `CARD_ENRICHMENT`, `/v3/backlinks/referring_domains/live`, and
   `BacklinkSnapshotRequest`. It is not a safe drop-in implementation for the
   three new qualification APIs.
6. Accepted asynchronous SERP tasks can be recovered by saved task ID.
   Synchronous paid `/live` requests cannot always be safely replayed after an
   ambiguous timeout.
7. The current AI usage query combines AI draft model runs and AI discovery
   Blueprint usage. Candidate-level semantic assessment would make the conflict
   worse unless the budget foundation is split first.
8. Historical and current reassessment services import the V3 scorer.
   Replacing that module in place would reinterpret historical evidence.
9. Gmail preflight and commit-time checks protect real invariants, but several
   branches collapse to a generic conflict. The final transactional check must
   remain even after rule evaluation is consolidated.
10. The target `main` has two migration authorities that are not yet validated
    as one deployable graph. Backlinks Core reaches `0060`, while the platform
    Alembic graph reaches `20260814_0064`. The deployment manifest records
    Alembic `20260724_0007` and Backlinks `0060`, but its migration-system test
    still asserts a frozen partial list and Backlinks head `0031`. The next
    number and every current-head reference must be rechecked when coding
    starts because this is false-confidence risk, not a cosmetic mismatch.
11. The historical UI/UX document allows local Mock send, simulated replies,
    simulated link checks, and simulated reports. Current production outreach
    source tests explicitly reject Mock/fallback behavior in several product
    modules. Prototype and production acceptance must therefore be separated
    before frontend changes.
12. The current Opportunity creation command requires a
    `contactCandidateId` and rejects a recommendation when the selected public
    contact is not eligible. It cannot represent a contact-form,
    submission-page, or editor-page Opportunity without a new versioned
    contract.
13. Current Draft and SendIntent contracts are email/contact-specific. They
    must remain strict for Gmail; non-email content and manual submission
    evidence require a separate channel-specific action contract.
14. Opportunity state, Reply projection, negotiation facts, Placement, Links,
    and Reports already exist as separate modules. A single new “master
    lifecycle status” would duplicate and contradict those authorities.
15. Placement candidates may initially be unmatched, while promoted
    Placements require Opportunity lineage. Full product acceptance must
    distinguish imported/unmatched link evidence from an outreach-derived
    Placement.
16. The integrated Platform Project does not currently contain the legacy
    Workspace/lifecycle/outreach-input contract. `SiteProfile` is
    machine-discovered website evidence and cannot silently become
    user-confirmed Backlinks intent.
17. General Project CRUD currently uses a default organization path, while the
    Backlinks gateway resolves signed organization/workspace/project
    membership. These cannot remain separate production authorities.
18. The frontend Project Context can fall back to the first Project for an
    unknown route ID, and several outreach pages do not reject the mismatch.
    Exact route Project identity is a blocking correctness and isolation
    requirement.
19. The integrated Project service exposes destructive deletion and no
    archive/restore lifecycle. A normal Project action cannot orphan
    Backlinks, Gmail, Reply, Placement, monitoring, or report history.
20. The legacy `ops/local-product` runtime was removed. The target
    `scripts/dev-up.ps1` and Compose stack do not currently start Backlinks
    Core API or its Temporal Worker, so provider and Workflow behavior cannot
    be accepted on the target runtime yet.
21. Legacy platform revisions `20260805_0008`,
    `20260806_0009`, `20260813_0010`, and Backlinks migration `0044` are absent
    from target `main`. Existing databases that applied them require additive
    compatibility bridges before any new migration is accepted.
22. The integrated Keyword and Content modules already own DataForSEO-derived
    keyword, competitor, SERP, content, request, cost, and freshness facts.
    Backlinks must not create a second source of truth for those facts.
23. Backlinks already owns separate provider artifacts, cost controls, and
    candidate qualification evidence. Those records remain authoritative for
    Backlinks-specific Traffic, Spam, Authority, accessibility, contact, and
    cooperation-path decisions.
24. The current Backlinks project projection can carry Project, profile,
    products, keywords, target URLs, audiences, and market facts, but the
    integrated frontend adapter derives an incomplete subset from SiteProfile.
    A versioned Outreach Profile and Shared SEO Evidence adapter are required
    before recommendation inputs are considered complete.
25. The first integration step must not rewrite every Keyword, Content, and
    Backlinks DataForSEO client into one service. That would expand the blast
    radius before data ownership and idempotency contracts are proven.
26. Integrated production routing already uses global `/projects`,
    `ProjectProvider`, `ProjectsPage`, and `CreateProjectDialog`; the
    Backlinks manifest has no `projects` tab.
27. The integrated `features/projects/project-workspace.tsx` is an unused
    local-Mock surface, while the legacy file with the same name is a different
    real Gateway-backed project manager. Similar filenames are not compatible
    implementations and must not be copied over each other.
28. The final product keeps the global Project center as the only management
    entry. Legacy switch, archive/restore, detailed profile, and recovery
    behavior is ported into the integrated Project Context, Project center,
    and settings; Backlinks owns only its versioned Outreach Profile.

## 3. Change-Control Rules

1. Database migrations are append-only. Released migrations are never edited.
2. Migration numbers in this document are provisional. Re-read the migration
   manifest and directory immediately before creating each migration.
3. Legacy V3 evidence remains readable and immutable. New qualification uses a
   new version; existing rows are never silently reinterpreted as new evidence.
4. Every generation pins its qualification contract, traffic scope, scoring
   rule, and visibility contract. One generation must never contain mixed V3
   and corrected-contract writes.
5. Database changes are additive first. Destructive constraints, old columns,
   and old readers are removed only after dual-read/dual-write compatibility
   and delayed-Worker tests pass.
6. OpenAPI changes precede generated clients, but the UI may consume a new
   state only after the backend can truthfully produce it.
7. No two implementation tasks may edit the same ownership surface in
   parallel. Each authorized phase records its owned files before editing.
8. Historical result documents remain immutable evidence snapshots.
9. Real DataForSEO calls are required for provider acceptance, but unit and
   contract tests do not make paid calls.
10. Provider ledgers, reservations, leases, and unknown-charge controls remain.
    Removing product-owned budget blocking does not mean deleting cost and
    idempotency infrastructure.
11. A paid request is retried only when its dispatch outcome is known. An
    ambiguous synchronous `/live` request becomes `unknown_charge` and is not
    automatically resent.
12. Gmail acceptance stops before real send unless the user separately unlocks
    the human-confirmation checkpoint.
13. Final repository and database invariant checks remain authoritative.
    Consolidation removes duplicated rule calculation, not atomic enforcement.
14. A phase may not opportunistically refactor adjacent modules.
15. A phase is not complete while the UI shows a state unsupported by persisted
    backend facts.
16. Prototype fixtures and Mock adapters remain isolated from production
    routes. A real API failure never falls back to a fake product success.
17. Business facts and operational execution state remain separate. The UI may
    derive `primaryNextAction`, but no phase introduces one mutable master
    status across Recommendation, Contact, Draft, Send, Reply, Negotiation,
    Placement, and Monitoring.
18. Changing market, keywords, or discovery source creates a new immutable
    generation input version. Continuing later with the same criteria resumes
    the same cursor and idempotent operation.
19. “Open URL” is not “submitted.” Manual non-email actions require explicit
    human confirmation and persisted evidence.
20. Platform Project, SiteProfile, and Backlinks Outreach Profile remain
    separate authorities: root identity/lifecycle, discovered website facts,
    and user-confirmed outreach intent respectively.
21. Normal Project removal is archive/restore. Destructive purge is a
    separately authorized retention operation and cannot be used when
    cross-module business history would be orphaned.
22. The exact route Project is authoritative. Unknown or unauthorized Project
    IDs never fall back to another Project.
23. Colleague-owned Project, SiteProfile, crawling, audit, keyword, content,
    and agent workflows are regression scope for the integration phase. They
    are not rewritten as part of Backlinks remediation.
24. Backlinks reads colleague-owned SEO facts through a stable versioned
    Shared SEO Evidence contract/API/projection. Direct cross-module table or
    repository access is prohibited.
25. Every recommendation generation pins Project, SiteProfile, Outreach
    Profile, shared evidence, traffic scope, and qualification-contract
    versions. Mid-run edits cannot change the generation.
26. Current real-provider evidence is reusable only when Project, endpoint,
    normalized parameters, market/language, provenance, and freshness match.
    Stale or untraceable cache entries are not compatible evidence.
27. Candidate Traffic, Spam, and Authority qualification remains
    Backlinks-owned. The same live artifact is reused only for the same
    generation/request fingerprint; unrelated upstream evidence cannot satisfy
    the hard qualification gates.
28. `/projects` is the only production Project-management entry.
    `CreateProjectDialog` creates one Platform Project, the App Shell switcher
    selects the same exact route Project, and Backlinks must not add a second
    `projects` tab or Project provider.
29. Provider credential and account-health state is shared infrastructure,
    while module operations, retries, usage ledgers, and failure states remain
    isolated.

## 4. Mandatory Re-entry Audit

This audit is repeated before every implementation phase and again before its
result is accepted. A previous phase result does not waive it.

### Pass A: Ownership And Static Conflict

- record `git status`, current branch, migration head, generated-client state,
  and all already-modified owned files;
- verify the current Platform Alembic head, Backlinks SQL head,
  `backend/database/deployment-manifest.v1.json`, migration validation, local
  startup support, and runtime tests represent one deployable graph;
- verify the target commit still descends from the audited integrated baseline
  and identify colleague-owned Project changes added after that baseline;
- search for every old threshold, status, score-model version, contact-ready
  count, endpoint allowlist, timeout, retry, and Kill Switch copy touched by
  the phase;
- identify SQL constraints, runtime scripts, Workers, tests, OpenAPI, generated
  clients, and UI consumers that enforce the same rule;
- identify the source authority, version, freshness rule, provider endpoint,
  request fingerprint, and consumer for every shared Project/SEO fact touched
  by the phase;
- reject any planned direct Backlinks dependency on colleague-owned internal
  tables or repositories;
- stop if another unfinished task owns an overlapping file or migration number;
- write the exact owned-file list into the phase result before editing.

### Pass B: Timeout, Retry, And Idempotency

- classify each external action as `not_dispatched`, `accepted_async`,
  `completed_live`, `retryable_no_charge`, or `unknown_charge`;
- verify HTTP timeout is shorter than its Activity timeout and every Activity
  is shorter than the execution-slice deadline;
- verify every loop has a persisted cursor, bounded iterations, a next retry,
  and an exit state;
- verify restart and repeated commands resume persisted work instead of
  starting a parallel paid request;
- verify partial success persists completed candidates and retries only the
  unresolved subset;
- stop if any ambiguous paid call can be blindly replayed.

### Pass C: Compatibility And Activation

- verify old generations remain readable under their pinned contract;
- verify delayed old Workers cannot write into a new-contract generation;
- verify additive migration, application deployment, Worker activation,
  generated-client rollout, and UI rollout order;
- verify rollback or forward-fix behavior does not require editing a released
  migration or deleting provider evidence;
- verify the behavior switch is scoped to new corrected-contract generations
  until migration acceptance is complete;
- verify production frontend modules do not import fixtures, Mock adapters, or
  fake-success fallbacks;
- verify project switching cancels old reads and that late responses are
  rejected unless project, generation, and operation identities still match;
- verify Project CRUD and the Backlinks gateway resolve the same tenant,
  workspace, Project, and permission authority;
- verify an invalid route Project cannot render or mutate the first available
  Project;
- verify Project archive/restore and Outreach Profile version behavior remain
  compatible with SiteProfile refresh;
- verify a generation keeps pinned SiteProfile, Outreach Profile, keyword,
  shared-evidence, market, and qualification-contract versions after upstream
  edits;
- verify page refresh, polling, restart, and Workflow replay cannot create a
  new paid request;
- stop if frontend and backend can observe incompatible state definitions.

### Required Phase Result

Every authorized phase writes:

```text
backend/core/docs/execution/
BACKLINKS-CORE-REMEDIATION-PHASE-<N>-result.md
```

The result must contain the three audit passes, owned files, commands,
evidence classes, external calls and costs, remaining risks, and an explicit
`PASS`, `BLOCKED`, or `INPUT_REQUIRED`. Coding must stop at that phase's exit
criterion.

The mainline reconciliation uses phase IDs `M1A`, `M1B`, and `M1C`, producing:

```text
BACKLINKS-CORE-REMEDIATION-PHASE-M1A-result.md
BACKLINKS-CORE-REMEDIATION-PHASE-M1B-result.md
BACKLINKS-CORE-REMEDIATION-PHASE-M1C-result.md
```

## 5. Compatibility And Deployment Model

The corrected recommendation behavior is a new qualification contract, not an
in-place rewrite of `recommendation-commercial-fit.v3`.

Required deployment ladder:

```text
additive database migration
-> domain and repository dual-read support
-> new provider/qualification services behind contract version
-> shadow evaluation from already authorized persisted evidence
-> focused backend and migration acceptance
-> activate new contract for newly created generations
-> OpenAPI and generated client
-> frontend projection
-> drain or reject delayed legacy Worker writes
-> later cleanup in a separately authorized phase
```

Existing V3 generations remain readable and keep their original evidence.
They do not accept corrected-contract candidates. A corrected generation is
created through the normal governed generation path: idempotent generation-1
initialization for a complete new project, or an explicit next-generation
command thereafter. It pins the new contract. During cutover, an in-flight
legacy generation must either finish under V3 or be frozen as legacy before a
corrected generation starts; it is never converted row by row.

The six product states are projections from independent persisted facts.
They are not a single mutable enum that permits impossible combinations.

Each corrected generation also stores immutable references to:

```text
Platform Project
SiteProfile version
ProjectOutreachProfile version
Shared SEO Evidence snapshot versions
market/location/language scope
qualification and visibility contracts
```

The Shared SEO Evidence boundary is read-oriented during this remediation.
Source modules remain responsible for producing and refreshing their own
facts. Backlinks normalizes and pins compatible evidence before use.

The minimum fact boundaries are:

```text
generation operation
recommendation qualification and visibility
cooperation path
contact
outreach content
send or manual submission
reply
negotiation
placement
link monitoring and reporting
```

## 6. Timeout And Execution Model

The current two-hour provider Activity and unbounded coordinator loop must not
be retained.

| Stage | Required boundary |
|---|---|
| Synchronous DataForSEO `/live` HTTP | Configured connect/read deadline, initially targeted at no more than 60 seconds and verified against real provider behavior |
| Asynchronous SERP | Short submit Activity, persisted accepted task ID, separate bounded poll Activities; never hold one Activity for the full provider wait |
| SafeFetch | Per-URL timeout below its Activity timeout, at most two pages, transient-only retry with jitter |
| AI semantic assessment | Bounded request timeout and one malformed/unavailable retry from the same evidence snapshot |
| Durable coordinator | A bounded execution slice, initially targeted at 15 minutes, with persisted cursor and explicit `completed`, `paused`, `retry_scheduled`, or `failed` exit |
| Long-lived generation | May remain truthfully `building`, but resumes through a scheduled command/signal or `continueAsNew`; it does not hold an infinite Workflow history |

Exact timeout values are configuration owned and must be finalized by focused
tests plus a controlled real-provider acceptance window. The window records
its request plan and actual calls and has no arbitrary three-call acceptance
cap. The ordering invariant is mandatory:

```text
HTTP deadline < Activity start-to-close < execution-slice deadline
```

Provider concurrency is configurable and bounded separately for discovery,
bulk metrics, SafeFetch, and AI. It is not a single hard-coded global value.
Rate-limit responses reduce concurrency or schedule a retry; they do not
trigger a busy loop.

## 7. DataForSEO Paid-Request Rules

Discovery and qualification are separate provider capabilities:

- shared Project/Keyword/Content/competitor/SERP evidence is consumed through
  the Shared SEO Evidence contract when it is current and scope-compatible;
- discovery sources keep their existing typed discovery registry and parsers;
- bulk Traffic, Spam Score, and Rank use a new typed qualification port,
  request schema, parser, artifact schema, and batch store;
- the existing `ProviderBulkRequestService` is reused only after an explicit
  generic refactor proves compatibility, otherwise it remains unchanged.

Retry rules:

1. Async SERP `task_post` accepted with a task ID:
   persist the task ID and recover only through the corresponding `task_get`.
2. Sync `/live` failure proven before dispatch:
   the same higher-level operation may retry with a new attempt record.
3. Sync `/live` success with missing target rows:
   persist the completed batch and retry only unresolved targets in a new
   bounded batch attempt linked to the same qualification operation.
4. Sync `/live` timeout or transport failure after possible dispatch:
   persist `unknown_charge`, quarantine the exact batch fingerprint, expose
   reconciliation, and do not automatically resend it.
5. Browser refresh, API status polling, Workflow replay, and Worker restart:
   read persisted state and never create a new paid request.
6. Current upstream discovery evidence with exact Project, endpoint,
   normalized parameters, market/language scope, provenance, and freshness:
   pin and reuse the immutable shared artifact; do not repeat the paid call.
7. Stale, untraceable, parameter-mismatched, or differently scoped upstream
   evidence: do not reuse it; request current evidence through the owning
   module contract or the authorized Backlinks provider path.
8. Backlinks Traffic, Spam, and Authority qualification: require a current
   live artifact for the generation and reuse it only for the same persisted
   generation/request fingerprint.

Each batch persists dispatch state, request fingerprint, target set, response
hash, per-target result, provider task ID when present, charge certainty, and
usage allocation. A real paid acceptance call is made only after focused
unknown-charge and idempotency tests pass.

## 8. File-Level Implementation Sequence

### Phase M1A: Contract, Authority, And Route Safety

Objective: freeze the colleague-integrated Platform Project and shared-data
contracts, make project routing exact, and remove cross-project UI fallbacks
before adding new persisted state. This phase adds no database migration,
persisted lifecycle or Outreach Profile behavior, runtime startup change,
recommendation scoring, provider call, draft, Gmail authorization, send, or
send/sync behavior.

Primary authority:

```text
docs/architecture/backlinks-main-integration-compatibility-audit-v1.md
```

Likely ownership:

```text
backend/api/app/modules/projects/schemas.py
backend/api/app/modules/projects/authority.py
backend/api/app/api/routes/projects.py
backend/api/app/core/authoritative_platform_context.py
backend/api/app/core/backlinks_gateway.py
backend/api/app/modules/keywords/ (shared read contract and tests only)
backend/api/app/modules/content/ (shared read contract and tests only)
backend/api/app/modules/performance/ (GSC evidence read contract and tests only)
backend/api/app/modules/settings/gsc.py (GSC provenance/connection read contract only)
backend/core/src/modules/backlinks/application/commands/project-context-projection.command.ts
backend/core/src/modules/backlinks/ports/ (shared evidence port)
frontend/src/api/projects.ts
frontend/src/App.tsx
frontend/src/app/app-shell.tsx
frontend/src/features/projects/types.ts
frontend/src/features/projects/project-context.tsx
frontend/src/features/projects/project-context.test.tsx
frontend/src/features/projects/create-project-dialog.tsx
frontend/src/features/outreach/project.ts
frontend/src/features/outreach/module.tsx
frontend/src/features/outreach/manifest.ts
frontend/src/pages/projects-page.tsx
frontend/src/pages/settings-page.tsx
frontend/src/features/projects/project-workspace.tsx
```

Work:

- keep Platform Project as root tenant identity and keep SiteProfile as
  machine-discovered website evidence;
- keep `/projects` and `CreateProjectDialog` as the only Project-management
  and creation entry;
- add or retain one App Shell Project switcher backed by the same exact
  Project Context and route ID;
- keep the Backlinks manifest free of a `projects` tab and isolate the unused
  Mock Project workspace from production imports;
- define Backlinks profile editing under Project settings as versioned
  Outreach Profile behavior rather than a second Project creation flow;
- define, but do not yet persist, Project `ACTIVE`/`ARCHIVED` lifecycle and
  archive/restore behavior;
- define, but do not yet persist, a Backlinks-owned immutable Outreach
  Profile/Promotion Target domain and wire contract for keywords,
  products/services, target URLs, audiences, partnership goals,
  market/language scope, authorized sources, and input fingerprint;
- define the versioned Shared SEO Evidence schema and a read adapter for
  SiteProfile, keyword metrics, competitor/SERP, content, and GSC evidence;
- preserve each source module as the authority for its own facts and prohibit
  direct Backlinks reads of colleague-owned internal tables;
- define generation input pins for Project, SiteProfile, Outreach Profile,
  shared evidence, market scope, and qualification contract;
- define exact reuse/freshness rules and truthful provenance for shared
  DataForSEO evidence without centralizing all provider clients in this phase;
- align Project CRUD and Backlinks gateway to one authenticated
  organization/workspace/project authority;
- remove first-Project route fallback, cancel stale polling, and reject late
  cross-project responses;
- define archive/delete dependency and orphan-prevention contracts without
  changing persisted deletion behavior in this phase;
- isolate Mock/demo Project and provider surfaces from production routes and
  production acceptance;
- do not expose placeholder lifecycle, Outreach Profile, or generation-pin
  values from a production API before Phase M1B can persist them truthfully;
- regression-test colleague-owned Project creation, SiteProfile, crawler,
  audit, keyword, content, and agent flows.

Verification:

- exact Project route, authorization, and stale-response tests;
- global Project center and App Shell switcher resolve the same Project ID;
- one create action creates one Platform Project and continues through the
  existing business-profile onboarding;
- production source checks reject a Backlinks `projects` tab or Mock Project
  workspace import;
- lifecycle, Outreach Profile, archive/delete dependency, and persistence API
  contract tests without claiming database behavior;
- shared-evidence schema, source ownership, scope, freshness, provenance, and
  generation-pin contract tests;
- contract tests require pinned versions and reject substitution of a changed
  SiteProfile or keyword snapshot;
- page refresh and polling perform zero provider calls;
- production source checks reject Mock fallback;
- colleague-owned Project workflows remain green.

Exit criterion: the target `main` has one Project authority, one
Project-management entry, one current-Project state, exact routing, no
first-project or stale-response fallback, and reviewed lifecycle, Outreach
Profile, Shared SEO Evidence, generation-pin, and archive/delete contracts. No
result from this phase may claim that those new contracts are persisted.

### Phase M1B: Additive Persistence And Migration Compatibility

Objective: implement the Phase M1A lifecycle, Outreach Profile, shared-evidence,
and generation-pin contracts with additive persistence and prove one
forward-upgradable database graph. This phase starts only after Phase M1A is
`PASS` and adds no Core runtime startup change, recommendation scoring,
provider call, draft, Gmail authorization, send, or send/sync behavior.

Likely ownership:

```text
backend/api/app/modules/projects/models.py
backend/api/app/modules/projects/schemas.py
backend/api/app/modules/projects/service.py
backend/api/app/api/routes/projects.py
backend/api/migrations/versions/
backend/api/tests/test_database_migration_system.py
backend/api/tests/test_projects.py
backend/api/tests/test_shared_contracts.py
backend/database/deployment-manifest.v1.json
backend/contracts/openapi/platform.v1.json
backend/core/src/modules/backlinks/db/migrations/
backend/core/scripts/check-backlinks-migrations.ts
frontend/src/api/projects.ts
frontend/src/app/app-shell.tsx
frontend/src/features/projects/types.ts
frontend/src/features/projects/project-context.test.tsx
frontend/src/pages/projects-page.tsx
frontend/src/pages/settings-page.tsx
```

Work:

- add persisted Project `ACTIVE`/`ARCHIVED` lifecycle and archive/restore APIs;
- add versioned, immutable Backlinks Outreach Profile persistence;
- add versioned Shared SEO Evidence references and immutable generation input
  pins without copying colleague-owned source tables into Backlinks;
- enforce archive/delete dependency guards that preserve Backlinks, Gmail,
  Reply, Placement, monitoring, and report history;
- add forward-only compatibility for databases that applied legacy Alembic
  revisions `20260805_0008`, `20260806_0009`, `20260813_0010`, or Backlinks
  migration `0044`;
- replace the frozen partial migration-head assertion with validation of the
  actual deployable Alembic and Backlinks graphs while preserving immutable
  source-revision checksum tests;
- add baseline-drift checks so later phases stop when migration heads,
  generated contracts, or persistence ownership changed after this result.

Verification:

- Project edits, lifecycle, archive/restore, Outreach Profile versions, shared
  evidence references, and generation pins persist after restart;
- archive preserves dependent Backlinks, Gmail, Reply, Placement, Links, and
  Report history, while ordinary delete cannot orphan that history;
- source-module facts remain owned by their source modules and are referenced
  by immutable identity/version instead of duplicated as mutable Backlinks
  truth;
- changing Project, SiteProfile, keyword, or Outreach Profile data creates a
  new input version and cannot mutate an already persisted generation pin;
- fresh database to current heads;
- legacy Alembic `20260813_0010` database to current head;
- database with Backlinks `0044` already applied to current head;
- deployment manifest and startup validation identify the same current graph;
- Platform OpenAPI is regenerated from the truthful persisted backend contract,
  and frontend mappings consume no state the backend cannot produce;
- migration and persistence tests issue no provider request, paid AI call,
  Gmail authorization, or Gmail send.

Exit criterion: Project lifecycle, Outreach Profile, Shared SEO Evidence
references, generation pins, dependency guards, migration upgrade continuity,
and current-head validation are proven without changing runtime activation.

### Phase M1C: Integrated Core Runtime Reconciliation

Objective: prove one local runtime that starts the Platform API, frontend,
Backlinks Core API, and Backlinks Core Worker with one explicit configuration
ownership model and truthful health. This phase starts only after Phase M1B is
`PASS` and adds no recommendation scoring, provider call, draft, Gmail
authorization, send, or send/sync behavior.

Likely ownership:

```text
backend/api/app/core/backlinks_runtime_status.py
backend/core/src/modules/backlinks/runtime/
scripts/dev-up.ps1
scripts/dev-down.ps1
deploy/compose/.env.example
deploy/compose/compose.yaml
```

Work:

- integrate Backlinks Core API and Backlinks Core Worker into the current
  `scripts/dev-up.ps1`/Compose runtime and one current configuration source;
- expose Core API health and Core Worker execution health as separate facts;
- preserve provider-disabled test/CI startup and issue no paid provider,
  Gmail, or AI action during runtime acceptance;
- preserve configured desired state across ordinary restart without creating
  paid work;
- add baseline-drift checks so later phases stop when runtime ownership or
  configuration contracts changed after this result.

Verification:

- local startup proves Platform API, frontend, Core API, and Core Worker are
  alive without a provider request, paid AI call, Gmail authorization, or
  Gmail send;
- health distinguishes API alive, Worker running, Worker paused/quiesced,
  provider configured, and provider externally unavailable;
- ordinary restart preserves configured desired state but creates no paid
  work;
- page refresh, polling, process restart, and Workflow replay do not create a
  provider request.

Exit criterion: integrated Core runtime, truthful API/Worker health,
configuration ownership, restart behavior, and zero-action startup are proven.
For sequence control, the M1 prerequisite is satisfied by the original M1A
result plus its accepted input-resolution record, M1B `PASS`, and M1C `PASS`.
The original M1A result remains immutable. This resolution permits only an
individually authorized later phase.

### Phase 0: Contract And Re-entry Guard

Objective: freeze authority and add no runtime behavior.

Primary files:

```text
docs/architecture/backlinks-core-value-chain-remediation-v1.md
docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md
docs/architecture/backlinks-main-integration-compatibility-audit-v1.md
backend/core/docs/execution/backlinks-ai-coding-state.md
docs/SEO自动化平台-UIUX需求文档-V1.2.md
```

Work:

- confirm product states, qualification rules, source labels, cooperation-path
  types, exact error codes, and evidence classes;
- freeze Shared SEO Evidence ownership, freshness, provenance, version pins,
  and no-direct-table-access rules;
- freeze prototype-versus-production acceptance and prohibit runtime Mock
  fallback;
- record `WEBSITE-PROJECT-V3-E2E-002` as historical and inactive;
- freeze generation recovery actions and the separation between operational
  state and business facts;
- record legacy V3 compatibility and new-generation activation rules;
- run the Mandatory Re-entry Audit and record current migration head;
- do not edit OpenAPI, generated clients, runtime code, or migrations.

Exit criterion: one unambiguous authority chain and no historical task that can
be mistaken for current coding permission.

Phase 0 frozen outcome:

- Platform Alembic head: `20260815_0065`;
- Backlinks SQL head: `0061`;
- Shared SEO Evidence remains a versioned API/contract/projection boundary
  with Project, source version, endpoint, normalized parameters, market,
  provenance, freshness, and fingerprint checks; direct reads of
  colleague-owned internal tables are prohibited;
- top-level evidence classes are code/contract, build/typecheck,
  migration/OpenAPI/generated client, focused automated tests, local runtime
  health, real provider behavior, human Gmail confirmation/send, and product
  UAT; each exact result states which class was actually executed;
- provider external-action states are `not_dispatched`, `accepted_async`,
  `completed_live`, `retryable_no_charge`, and `unknown_charge`;
- legacy V3 generations remain readable and pinned; only newly created
  generations may be activated on a corrected contract after additive rollout
  and an exact later-phase result;
- the Phase 0 result is
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-0-result.md`;
- Phase 1 is `PASS`; its exact implementation and isolated zero-call restart
  evidence are recorded in
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-1-result.md`;
- Phase 2 is `PASS`; its additive compatibility implementation and zero-call
  evidence are recorded in
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-2-result.md`;
- Phase 3 is `BLOCKED`; its capability foundation, historical assertion
  recovery, and restored credential importers are tested. Unit `692/692`, API
  `123/123`, and Contract `185/185` pass, while the required repository gate
  remains red at Integration on test-database permission/migration state and
  Temporal Worker memory exhaustion. Its exact evidence is recorded in
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-3-result.md`
  and
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-3-IMPORTER-RECOVERY-result.md`;
- Phase 4 and every later phase are `NOT_AUTHORIZED`.

### Phase 1: Provider Configuration And Diagnostics

Objective: keep DataForSEO and Browser configured on in LOCAL_PRODUCT while
reporting truthful external unavailability.

Likely ownership:

```text
backend/core/src/modules/backlinks/runtime/live-capabilities.ts
backend/core/src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.ts
backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts
backend/core/src/modules/backlinks/application/policies/dataforseo-call.policy.ts
backend/core/src/modules/backlinks/api/settings/settings-governance.route.ts
backend/api/.env.example
backend/api/app/core/backlinks_gateway.py
backend/api/app/core/backlinks_runtime_status.py
deploy/compose/.env.example
deploy/compose/compose.yaml
scripts/dev-up.ps1
scripts/dev-down.ps1
```

Work:

- persist `DATAFORSEO_ENABLED=true` and `BROWSER_PROVIDER_ENABLED=true`;
- keep normal DataForSEO Kill Switch state `blocked=false`;
- prevent ordinary start/restart from silently disabling either capability;
- retain provider usage, reservation, lease, and unknown-charge records;
- centralize the policy that provider balance, rather than an arbitrary product
  call/spend ceiling, determines DataForSEO availability;
- scope unknown-charge blocking to the exact affected request fingerprint;
- return exact balance, credential, rate-limit, timeout, outage,
  unknown-charge, explicit-block, and Worker-state reasons;
- preserve provider-disabled test and CI configuration.

Verification:

- configuration, startup, restart, and capability contract tests;
- all allowlist/configuration copies inventoried;
- local restart proof without a provider request.

Exit criterion: configured state survives restart and an unavailable provider
has one exact reason and recovery action.

### Phase 2: Additive Compatibility Foundation

Objective: add storage and versioning without switching recommendation
behavior.

Provisional migrations:

```text
<next>_backlink_recommendation_qualification_contract.sql
<next>_backlink_recommendation_visibility_facts.sql
```

The numbers are assigned only after rechecking the migration head.

Migration integration ownership also includes:

```text
backend/database/deployment-manifest.v1.json
backend/api/tests/test_database_migration_system.py
backend/core/scripts/check-backlinks-migrations.ts
backend/core/test/unit/project-deletion-workflow.test.ts
scripts/dev-up.ps1
deploy/compose/compose.yaml
```

Work:

- add immutable references from corrected generations to SiteProfile,
  Outreach Profile, Shared SEO Evidence snapshots, market scope, and request
  fingerprints;
- add generation-level qualification and visibility contract versions;
- add independent generation-operation, fit, visibility, contact, and
  cooperation-path facts without adding a cross-module master status;
- add metric scope, Traffic, Spam, Authority, accessibility, semantic,
  attempt, decision-reason, model, prompt, and rule evidence;
- extend score-version constraints additively for the corrected version;
- implement repository dual-read and version-guarded dual-write;
- keep all current V3 publication/count/query behavior active;
- reject a write when Worker contract version and generation contract version
  differ;
- do not activate new UI states.

Verification:

- clean install and historical upgrade;
- legacy V3 read tests;
- corrected-contract round-trip tests;
- delayed old-Worker write rejection;
- no change to current visible recommendation count.

Exit criterion: the database can safely hold both contracts without changing
current product behavior.

Phase 2 result: `PASS`. Backlinks SQL head is `0063`; corrected-contract
storage and repository compatibility are present but are not connected to the
current Worker or UI. Phase 3 was separately authorized and is recorded
below.

### Phase 3: AI Capability And Budget Foundation

Objective: split AI discovery capacity from outreach draft capacity before
candidate-level semantic calls exist.

Likely ownership:

```text
backend/core/src/modules/backlinks/runtime/local-product-ai-runtime.ts
backend/core/src/modules/backlinks/runtime/local-product-ai-bootstrap.ts
backend/core/src/modules/backlinks/application/repositories/draft-generation.repository.ts
```

Work:

- create independent `AI_DISCOVERY` and `AI_OUTREACH_DRAFT` ledgers, counters,
  windows, readiness, and locking identities;
- count discovery Blueprint and recommendation semantic usage only against
  `AI_DISCOVERY`;
- count draft generation only against `AI_OUTREACH_DRAFT`;
- renew expired windows independently and immediately;
- preserve existing draft behavior while storage changes;
- bound semantic concurrency and per-generation work so “no arbitrary
  DataForSEO cap” cannot become unlimited AI calls.

Verification:

- migration and concurrent-lock tests;
- discovery cannot exhaust draft capacity;
- draft cannot exhaust discovery capacity;
- expiry and immediate renewal tests;
- current draft generation remains compatible.

Exit criterion: semantic qualification can be added without destabilizing AI
draft generation.

Phase 3 result: `PASS`. Backlinks SQL head is `0064`; the independent
capability budget foundation is implemented and focused-tested. The historical
assertions, missing credential importers, Integration blockers, and missing
Resilience runbook are resolved. The latest complete gate passes Unit
`692/692`, API `123/123`, Contract `185/185`, Integration `220` tests with
`13` skipped, Security `110/110`, and Resilience `8/8`. Exact evidence is
recorded in
`backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-3-result.md` and
`backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-3-RESILIENCE-RECOVERY-result.md`.
No Phase 4 behavior was activated, and Phase 4 remains `NOT_AUTHORIZED`.

### Phase 4: Bounded Discovery And Qualification In Shadow Mode

Objective: implement the corrected qualification path without changing what
users currently see.

Likely ownership:

```text
backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts
backend/core/src/modules/backlinks/application/services/commercial-discovery-request.service.ts
backend/core/src/modules/backlinks/application/services/commercial-supply-operation.service.ts
backend/core/src/modules/backlinks/application/services/commercial-qualification-bulk.service.ts
backend/core/src/modules/backlinks/application/services/commercial-qualification-production.service.ts
backend/core/src/modules/backlinks/application/services/commercial-qualification-shadow.service.ts
backend/core/src/modules/backlinks/domain/recommendations/commercial-score-v3.ts
backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-source.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts
backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts
backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts
backend/api/.env.example
deploy/compose/.env.example
deploy/compose/compose.yaml
```

Work:

- consume pinned compatible Shared SEO Evidence for Project/site/keyword/
  competitor/SERP discovery context before requesting missing or stale facts;
- treat competitors-domain as a bounded first-hop seed source only;
- query selected competitor seeds through `/v3/backlinks/backlinks/live` and
  create final competitor-derived candidates only from second-hop referring
  pages;
- retain source page URL, competitor target page URL, anchor text, active/lost
  state, first/last seen timestamps, and available source/target HTTP status;
- retain user-domain referring-domains and async SERP discovery;
- reserve initial capacity across curated, competitor second-hop, user
  referring-domain, and SERP source families before filling unused capacity;
- add typed adapters and allowlists for bulk Traffic, Spam Score, and Rank;
- keep bulk qualification endpoints out of the discovery-source parser;
- deduplicate canonical domains and use bounded chunks of at most 1,000;
- replace hard-coded provider concurrency `1` with bounded configuration;
- pin one `TARGET_MARKET` or `GLOBAL` Traffic scope per generation;
- apply `recommendation-commercial-fit-rules.v4` as the authoritative
  qualification policy;
- require Traffic `>=30000`, Spam Score `<=10`, confirmed accessibility,
  semantic relevance `>=60`, and the existing self/duplicate/suppression/
  safety/policy gates;
- use the `50/30/20` product, topic, and keyword-intent semantic weighting;
- keep the admission threshold fixed at `55`; an empty batch remains empty
  and must not retry at `50`, `45`, `40`, `35`, or `0`;
- use fresh DataForSEO Traffic, Spam, and Rank values as V4 evidence, with
  Rank used for deterministic ordering rather than as a substitute for
  traffic, spam, accessibility, or semantic qualification;
- retain V3.2 only as persisted screening evidence needed for compatibility;
- apply identical qualification gates to Resource Library candidates;
- replace the two-hour Activity and infinite loop with persisted bounded
  execution slices;
- persist partial success and all exact unavailable/retry states;
- evaluate shadow results from the same authorized provider evidence; shadow
  comparison must not issue a second paid call.

Verification:

- endpoint, allowlist, parser, request, chunking, and per-item persistence;
- first-hop competitor seeds never appear directly as candidates;
- second-hop candidates retain complete page-level backlink evidence through
  persistence, API projection, generated client, and UI;
- V4 rule/model persistence and exact `30000/10/60` gate behavior;
- fixed `55` admission with no lower-threshold fallback;
- low traffic, high spam, inaccessible, or semantically weak domains remain
  ineligible even when the pool would otherwise be empty;
- scope isolation and deterministic score/domain ordering;
- missing metrics, SafeFetch retry, semantic retry, partial success;
- timeout ordering, restart, cursor continuation, `continueAsNew` or scheduled
  resume, and no busy loop;
- async task recovery and sync `unknown_charge` no-resend tests;
- Resource Library parity;
- shared-evidence exact-scope reuse, stale/mismatched rejection, provenance,
  and input-version pinning;
- colleague Keyword/Content provider evidence remains readable and unchanged;
- one controlled real-provider acceptance window only after focused tests
  pass; record every real request and stop immediately on unknown charge.

Exit criterion: corrected qualification produces persisted shadow evidence,
uses real live data when authorized, survives restart, and cannot duplicate an
ambiguous paid request.

#### Phase 10 UAT Correction: Fixed V4 Admission

Phase 10 real-business UAT supersedes the earlier progressive V3.2 admission
rule for current production recommendation generations. Candidate admission
uses the V4 authority and never lowers the `55`-point threshold to create
inventory. Traffic below `30000`, Spam Score above `10`, failed accessibility,
semantic relevance below `60`, missing authoritative evidence, manual review,
and all existing safety or duplicate exclusions remain non-relaxable.

The correction also makes competitor supply explicitly two-hop. A
`competitors_domain/live` result is only a first-hop seed. The system then
queries selected competitors with `backlinks/live`, and only the resulting
referring domains may enter qualification. Their source page, target page,
anchor, link state, first/last seen timestamps, and available HTTP status
evidence are retained. No additional provider request is issued by threshold
evaluation or shadow comparison.

Website Project and Shared SEO Evidence remain the only authorities for
Project, keyword, competitor, SERP, Content, GSC, Site Profile, and audit
facts. Backlinks consumes immutable, project/version-scoped snapshots and
must not expose a second set of editable discovery inputs.

The minimum sufficient evidence set is:

- required: project and tenant identity, a current Site Profile containing the
  canonical site theme and language/market, at least one real promotion topic
  or published target URL, and matching project/profile/promotion versions;
- optional: approved keywords, published Content or audit evidence,
  competitor evidence, and GSC connection/evidence.

Optional evidence is strategy-dependent. Fresh competitor evidence enables
the competitor first-hop and second-hop plan; fresh keyword evidence expands
query topics; fresh Content or audit evidence supplies published targets and
semantic context; fresh GSC evidence improves observed-query and target
ranking. Missing optional evidence lowers completeness or disables only its
source plan. GSC absence alone never blocks discovery. The Provider boundary
fails closed only when required evidence is missing, stale, or version
mismatched, and the error must name the owning Website Project module and its
recovery action. It must not fall back to Backlinks free text, fabricate a
pin, or require all optional modules to exist.

### Phase 5: Recommendation Visibility Activation

Objective: activate corrected visibility for new-contract generations only.

Likely ownership:

```text
backend/core/src/modules/backlinks/domain/recommendations/recommendation-product-state.ts (new)
backend/core/src/modules/backlinks/application/services/recommendation-publication.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-reservation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.ts
backend/core/src/modules/backlinks/application/services/commercial-inventory-refill.service.ts
backend/core/src/modules/backlinks/application/commands/contact-enrichment.command.ts
backend/core/src/modules/backlinks/application/queries/recommendations.query.ts
backend/core/src/modules/backlinks/api/recommendations.route.ts
backend/core/src/modules/backlinks/api/openapi.ts
frontend/src/api/generated/backlinks.ts
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
```

Work:

- derive the six product states from independent facts;
- count discovered candidates as progress, not visible recommendations;
- show fit-verified candidates without public email;
- expose 1 through 9 verified results while executable work is running;
- activate at exactly 10 corrected-contract visible matches;
- persist and project `running`, `waiting_retry`, `paused_provider`,
  `partial_exhausted`, `maintenance`, and `blocked` separately from the
  generation workset lifecycle;
- transition to `partial_exhausted` when the current authorized attempt ends
  below 10; retain verified results, stop active elapsed time, and do not mark
  the generation successful;
- route market, keyword, target, and source recovery to their owning Website
  Project modules; Backlinks may continue unchanged criteria but must not
  create another editable authority for those inputs;
- create a new immutable input fingerprint for changed market, keywords, or
  source; resume the same cursor and operation for unchanged criteria;
- expose target/current counts, rejection breakdown, active processing time,
  next retry, provider availability, incurred cost, provider balance when
  returned, and separate AI capacity;
- keep recommendation cards scan-oriented; put evidence history, contact
  versions, rejection detail, and secondary operations in a detail drawer or
  dedicated sections;
- show the exact blocker and one recovery command for every disabled primary
  action;
- never invent a remaining DataForSEO product budget because no internal cap
  is currently configured;
- remove public-email and `80/70` requirements from corrected visibility only;
- retain `80/70` and current contact rules for automatic outreach readiness;
- update every SQL count, reservation, reconciliation, runtime write, route,
  OpenAPI, generated client, and UI projection together;
- keep legacy generation projection separate and read-only.

Verification:

- eight fit-verified/no-email candidates display as eight recommendations;
- old V3 generation remains readable and unchanged;
- no mixed-contract count or write;
- migration, query, service, API, generated-client, and UI tests;
- partial, empty, building, active, manual-review, and failure UI states.
- recovery-command versioning and no hard-gate relaxation;
- project-switch cancellation and stale-response identity rejection;
- desktop/mobile card density, detail drawer, disabled-action explanation, and
  confirmation-modal behavior;
- production source checks that reject fixtures, Mock adapters, and fake
  success fallback.

Exit criterion: corrected generations return qualified recommendations quickly
without waiting for contact enrichment, while legacy data stays consistent.

### Phase 6: Cooperation Path And Contact Productization

Objective: turn contact enrichment into understandable next actions instead of
a hidden recommendation gate.

Work:

- support public email, contact form, guest-post/submission page,
  resource-submission page, and editor/author page;
- require an absolute clickable evidence URL for verified paths;
- keep Browser public-page discovery enabled, bounded, and independent;
- apply `80/70` only to automatic outreach readiness;
- route lower-confidence evidence to manual review with operator confirmation;
- show the correct action for each path type;
- retain the current contact-required Opportunity command as the email path;
- add a versioned cooperation-path-based Opportunity command for verified
  non-email paths instead of fabricating a public contact;
- introduce channel-specific editable content types `EMAIL`, `FORM_MESSAGE`,
  and `SUBMISSION_PITCH` without weakening email Draft/SendIntent snapshots;
- persist manual action states `READY_FOR_MANUAL_ACTION`, `IN_PROGRESS`,
  `SUBMITTED`, `RESPONSE_RECEIVED`, `BLOCKED`, and `ABANDONED`;
- persist actor, timestamp, path URL, evidence, next action, and idempotency for
  every manual transition;
- do not automate form submission or CAPTCHA bypass in this phase;
- keep contact enrichment outside generation-completion latency.

Verification:

- path schema and URL validation;
- Browser disabled/failure diagnostics;
- restart, timeout, and per-path frontend interactions;
- manual-confirmation audit;
- contact-form Opportunity without a public email;
- “open URL” cannot produce `SUBMITTED`;
- duplicate manual confirmation replays idempotently;
- Gmail send readiness remains unchanged for email actions.

Exit criterion: every visible recommendation shows a usable path, enrichment
in progress, or a specific manual action, and non-email paths can enter an
auditable Opportunity without weakening Gmail safety.

### Phase 7: AI Draft State Machine

Objective: make draft generation recoverable and always useful on top of the
already-separated budget foundation.

Work:

- expose exact draft readiness and failure states;
- retry malformed output idempotently from a saved immutable snapshot;
- always create an editable basic draft after non-policy failure;
- label fallback as non-AI;
- preserve policy violation without silently bypassing policy;
- persist user edits independently from later AI retries.

Verification:

- every documented failure mode;
- editable fallback creation and persistence;
- retry and concurrent-edit protection;
- discovery usage cannot alter draft readiness.

Exit criterion: no non-policy AI failure leaves the user without an editable
draft.

### Phase 8: Gmail Connection And Readiness

Objective: separate OAuth connection from real send and sync readiness.

Work:

- project `CONNECTED`, `SEND_READY`, and `SYNC_READY` independently;
- centralize readiness calculation and return all blocking facts plus the
  primary recovery action;
- preserve project/workspace binding, scopes, identity, and secret checks;
- represent `waiting_for_accepted_send` as healthy pre-send state;
- make status reads bounded and restart-safe.

Verification:

- full connection/readiness matrix;
- project isolation and secret resolution;
- local OAuth/readiness without sending;
- UI recovery action for every blocker.

Exit criterion: a connected Gmail account never appears send-ready unless all
send requirements are currently true.

### Phase 9: Send, Sync, And Operational Hardening

Objective: consolidate duplicated rule calculation while retaining atomic send
enforcement and proving recovery across all four vertical chains.

Work:

- create one versioned readiness snapshot and shared rule evaluator;
- let command and repository compare snapshot version and idempotency;
- retain the final transactional checks for suppression, unsubscribe,
  frequency, quota, binding, scope, identity, approved version, contact
  version, and human confirmation;
- replace generic `409` branches with exact changed-condition details;
- make accepted send and sync cursor establishment idempotent;
- expose operation checkpoint, retryability, next retry, cost uncertainty,
  Worker mode, and build identity;
- keep operational state distinct from business state and expose one derived
  `primaryNextAction`;
- wait for persisted server confirmation before showing sent, submitted,
  replied, or placed success;
- remove obsolete duplicate implementations only after replacement coverage;
- run desktop and mobile UAT.

Verification:

- stale snapshot, duplicate submit, restart, accepted-unknown, and sync cursor;
- provider outage, low balance, malformed AI, missing metrics, transient site,
  semantic reassessment, and Worker restart;
- real send only in a separately authorized human-confirmation acceptance.

Exit criterion: every primary failure is explainable and recoverable from the
product, and no retry can duplicate an accepted message.

### Phase 10: Full Business Closure Integration And UAT

Objective: prove that the corrected core flows continue through the existing
Reply, Negotiation, Placement, Links, and Reports modules without creating a
second architecture.

This phase begins only after Phases M1A, M1B, M1C, and 0 through 9 pass their
own exit criteria.
It integrates existing modules and fixes only evidence-backed contract gaps;
it does not reopen recommendation scoring, Provider activation, AI budgets, or
Gmail send rules without a new scoped authorization.

The recommendation-supply prerequisite for this UAT uses the Phase 10
correction above: language-consistent search terms, curated-first bounded
source allocation, competitor first-hop discovery followed by second-hop
page-level backlink evidence, fixed V4 qualification, and truthful
raw-candidate counts. This correction exists only to unblock a real
recommendation-to-Opportunity input and does not create a new phase.

Work:

- CP11: synchronize a real reply, match it to the correct project and
  Opportunity, classify it, and route ambiguous forwarding, alias,
  auto-reply, multi-recipient, and cross-project cases to manual review;
- CP12: persist structured negotiation facts and user-confirmed corrections
  with reply and Opportunity lineage;
- CP13: create and validate an outreach-derived Placement with
  `projectId/opportunityId` lineage and source/target evidence;
- CP14: prove `active`, `changed`, and `lost` checks and include the result in
  the correct project report;
- make email and non-email action paths converge on response, negotiation,
  Placement, monitoring, and reporting without pretending every path used
  Gmail;
- preserve available `projectId`, `opportunityId`, `replyId`, and `placementId`
  context when navigating from Opportunity or Mail into Links or Reports, and
  provide a deterministic return path;
- clear stale deep-link filters and pending reads when the active project
  changes;
- test refresh, restart, multi-tab, project switching, provider timeout,
  `unknown_charge`, quiesced Worker, duplicate click, and network reconnect.

Verification:

- reply identity and ambiguity queue;
- negotiation fact versioning and correction audit;
- imported/unmatched link evidence cannot satisfy outreach-derived Placement
  acceptance;
- Placement and report attribution cannot cross projects;
- Opportunity/Mail-to-Links/Reports deep links retain the correct business
  object and return location, including after refresh;
- no duplicate paid request, Gmail send, manual submission, reply projection,
  Placement, or monitoring run under replay;
- desktop and mobile production UAT using persisted server facts, including
  detail drawers, confirmation modals, disabled actions, and reconnect.

Exit criterion: one real, project-attributed path reaches recommendation,
outreach action, response, negotiation, Placement, link monitoring, and report,
and the tested recovery scenarios remain explainable and idempotent.

## 9. Acceptance Matrix

| Evidence class | Required proof | Does not prove |
|---|---|---|
| Mainline contract/routing | Exact Project authority/routing, no first-project or stale-response fallback, lifecycle/Outreach/shared-evidence/generation-pin contracts, colleague-flow regression | Persistence, migration, runtime, provider, AI, or Gmail behavior |
| Mainline persistence/migration | Archive/restore, versioned Outreach Profile, shared-evidence references, generation pins, dependency guards, upgrade continuity, current migration heads | Core API/Worker startup or real provider behavior |
| Mainline runtime integration | Core API/Worker startup, configuration ownership, truthful Worker health, zero-action restart | Real provider or Gmail behavior |
| Code/contract | Reviewed domain rules, error schema, state schema | Runtime behavior |
| Build/typecheck | Backend and frontend compile/typecheck | Provider or Gmail readiness |
| Migration/OpenAPI/client | Clean install, upgrade, contract validation, regenerated client | Product usability |
| Focused automated tests | Visibility, idempotency, recovery, state transitions | External provider success |
| Local runtime health | API, Worker, Workflow, build identity, non-quiesced mode | Real DataForSEO results |
| Real DataForSEO | Real provider response, request/task identity, truthful source, exact failure evidence | Gmail or AI success |
| AI draft runtime | Independent budget, valid AI draft or editable labeled fallback | Gmail Send Ready |
| Gmail readiness | OAuth, binding, scopes, identity, secrets, quota, approved snapshot | Accepted send |
| Human-confirmed Gmail send | Explicit final confirmation, accepted message identity, no duplicate | Reply/sync recovery |
| Sync/restart | Cursor establishment, project isolation, restart recovery | Full user acceptance |
| Core product UAT | Operator completes the four remediation chains and recovers tested failures | Reply-to-report business closure |
| Full business UAT | CP11-CP14 prove reply, negotiation, Placement, monitoring, and report attribution | Future production reliability |

## 10. Completion Rule

No phase may be marked `PASS`, `DONE`, or product-accepted from documentation,
typecheck, HTTP `200`, generated-client output, or mocked frontend state alone.
The result artifact for each authorized phase must state which evidence classes
were actually executed and which remain unproven.

Phases M1A, M1B, M1C, and 0 through 9 may be described as “core remediation
complete” only after their evidence passes. “Full product flow accepted” is
reserved for Phase 10 CP11 through CP14. Neither phrase may be inferred from
the other.
