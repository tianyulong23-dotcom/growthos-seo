# WEBSITE-PROJECT-V3-E2E-001 Execution Manual

> Date: `2026-08-13`
>
> Status: `APPROVED_PLAN_NOT_STARTED`
>
> Acceptance Website: `https://manitosilk.com/`
>
> Product Scope: every current and future Website Project

## 1. Task Start Card

```text
taskId=WEBSITE-PROJECT-V3-E2E-001
repository=C:\Users\DELL\Documents\缝合\john3947-seo
skill=C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md
normativeArchitecture=docs/architecture/website-project-recommendation-blueprint-v3.md
instruction=docs/execution/WEBSITE-PROJECT-V3-E2E-001-execution-manual.md
result=docs/execution/WEBSITE-PROJECT-V3-E2E-001-result.md
acceptanceDomain=manitosilk.com
acceptanceMarket=United States
acceptanceCategory=pajamas
stopPoint=SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION
commit=false
push=false
```

This task supersedes `LOCAL-PRODUCT-038` as the active Website Project product
acceptance task. It MAY inherit verified code and focused tests from 018-038,
but it MUST NOT inherit their result status, project rows, manual repairs, or
provider evidence as proof that this task passed.

No later numbered task may start from this instruction.

## 2. Objective

Starting only from a valid public website URL and normal project inputs, the
ordinary product path MUST complete this workflow:

```text
create Website Project
-> persist project Context and Settings
-> derive Blueprint V3 from that project
-> run governed discovery until generation 1 contains exactly 10
-> expose a fixed 10-item Recommendation Pool
-> let the user move a selected item to Opportunity without refill
-> generate and persist a real evidence-grounded AI Draft
-> bind the project to a configured Gmail connection
-> pass final send preflight
-> stop at SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION
```

The task uses Manito Silk for real acceptance, but every implementation
decision and automated test MUST remain project-generic. A Manito-only success
is a task failure.

## 3. Product Acceptance

The task is accepted only when all of the following are true:

1. A cleanly created Manito Silk project reaches one `active` generation with
   exactly 10 unique, project-relevant, contact-ready, published
   recommendations.
2. The 10 recommendations come from the selected project's inputs and governed
   supply paths. No named-domain branch, manual database insertion, preloaded
   project inventory, shared cross-project cache, or hardcoded recommendation
   may contribute to acceptance.
3. The system continues progressive Blueprint/DataForSEO/Resource Library
   discovery until 10 are published. A partial pool, exhausted soft tier, or
   `SUPPLY_FLOOR_REACHED` MUST NOT be reported as success.
4. Soft relevance and authority thresholds MAY widen according to Blueprint
   V3. Public reachability, project/tenant isolation, contact evidence, usable
   public recipient email, suppression, and safety gates MUST NOT be relaxed.
5. Moving one recommendation to Opportunity leaves all 10 visible and creates
   no replacement request.
6. Archive-only archives the whole generation and creates no provider work.
   The next generation starts only after the explicit user command and again
   targets exactly 10 new project-relevant domains.
7. Ordinary project users do not browse the global Resource Library. They see
   only recommendations that its project-specific gates admitted into the
   Recommendation Pool. An administrative inventory view, if retained, is not
   part of the ordinary project workflow.
8. One selected recommendation becomes a real Opportunity with verified public
   contact evidence.
9. The configured AI provider produces a schema-valid, semantically relevant,
   evidence-grounded Draft. Deterministic or template fallback MUST remain
   visibly labeled and MUST NOT satisfy real-AI acceptance.
10. Gmail connection, Send Ready, and Sync Ready are independently truthful.
    `CONNECTED` alone is not acceptance.
11. Before the first accepted send, Mail Center returns promptly and shows
    `waiting_for_accepted_send`, not a spinner, timeout, empty unexplained
    screen, or false synchronization failure.
12. After the user approves the exact Draft Version, final preflight passes and
    the UI stops at `SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION`.
13. The task sends zero real Gmail messages without the user's current final
    confirmation.
14. Restart, refresh, repeated commands, and project switching do not duplicate
    Jobs, provider calls, generations, Opportunities, Draft Jobs, send intents,
    messages, or sync workflows.
15. Desktop and mobile product UAT show the same persisted state after restart.

## 4. Provider And Safety Ceiling

### DataForSEO

```text
cycleBudgetMicros=1000000
maxPaidCallsPerCycle=250
maxOpenCycles=1
cycleRotation=AUTHORIZED_AFTER_PRIOR_CYCLE_SETTLES
targetStop=10_PUBLISHED
```

There is no artificial supply-floor success. If the current settled cycle is
exhausted before 10, the implementation creates the next governed cycle and
continues from durable Blueprint cursors. Rotation MUST NOT clear history,
reuse charged windows, bypass the Kill Switch, or hide actual/unknown cost.
Unknown-charge work blocks rotation until reconciled.

### AI

```text
maxRealDraftAttemptsForAcceptanceOpportunity=3
templateFallbackCountsAsPass=false
```

Schema failure, semantic mismatch, unsupported claims, wrong recipient intent,
or missing project evidence triggers a bounded repair attempt. Failure after
the ceiling remains visible and blocks acceptance.

### Gmail

```text
maxRealGmailSendsBeforeFinalConfirmation=0
gmailConnectionRequired=true
gmailSendCapabilityRequired=true
gmailSyncCapabilityRequired=true
backgroundSyncMustBeBounded=true
```

OAuth credentials remain secret references. Gmail Send and Gmail Sync remain
independent from DataForSEO configuration and failure state.

## 5. Execution Order

The checkpoints are serial. A later checkpoint MUST NOT begin until the
previous checkpoint has focused evidence and the result document records its
status.

### Checkpoint 0: Inherited Work Isolation

Goal: turn the current dirty tree into a controlled baseline without deleting
or reverting user work.

Actions:

- record branch, HEAD, worktree count, unmerged-file check, and target-file
  status;
- create an inherited-change manifest for every file this task will touch;
- classify each inherited change as `adopt`, `repair`, or `defer`;
- run the current focused build, migration, OpenAPI, generated-client, and
  runtime identity checks before editing;
- preserve 018-038 result documents as historical evidence only;
- forbid concurrent edits to the shared hotspots listed in section 7.

Exit:

```text
unmergedFiles=0
inheritedHotspotsClassified=true
baselineFailuresRecorded=true
userChangesReverted=0
```

### Checkpoint 1: Runtime Truth And Mail Center

Goal: make Gmail and Mail Center truthful and usable before recommendation UAT.

Required implementation:

- serialize the small status queries that currently share one
  transaction-scoped PostgreSQL client; do not use concurrent query execution
  on that client;
- make Gmail sync status complete within the Gateway timeout, with a local UAT
  target below two seconds;
- project `CONNECTED`, Send Ready, Sync Ready, and missing gates separately;
- treat no History cursor before the first accepted send as
  `waiting_for_accepted_send`;
- show maintenance/quiesced Worker state visibly;
- show persisted project messages and visible sync errors;
- disable or explain manual sync when business consumers are unavailable;
- preserve tenant/project isolation and restart recovery.

Verification:

- unit test same-client status-query serialization;
- route tests for connected pre-send, post-send cursor, quiesced, provider
  error, and timeout prevention;
- frontend source tests for every visible state;
- live local Mail Center GET/status check with zero send side effects.

### Checkpoint 2: Generic Project Bootstrap

Goal: make the public project-creation path sufficient for downstream work.

Required implementation:

- create immutable Context and Settings Version from the submitted website,
  market, language, products, keywords, target URLs, audience, and goals;
- derive Blueprint V3 only from that persisted project state;
- start generation 1 exactly once through an idempotent command;
- remove or reject project-name/domain branches and shared project facts;
- fail visibly on missing required inputs instead of creating a broken project.

Verification:

- parameterized tests with at least three unrelated project contexts;
- source scan for Manito, SmileTV, AWOL, and ElephTV runtime special cases;
- project-switch and tenant-isolation tests.

### Checkpoint 3: Exact 10 Recommendation Generation

Goal: produce a complete fixed first generation through real governed supply.

Required implementation:

- run Blueprint V3 source order, adaptive windows, query expansion, and soft
  threshold tiers;
- use project-matched hidden Resource Library inventory before or alongside
  paid expansion according to the normative architecture;
- persist `(generation,tier,round,window)` cursors and provider fingerprints;
- continue governed cycle rotation until 10 publishable items exist;
- keep generation state `building` at 0-9 and atomically activate at 10;
- never publish an 11th item into the same generation;
- show real progress, pause reason, cost, and current tier without fake elapsed
  processing time.

Verification:

- focused unit/integration tests for 0, 1, 9, 10, and 11 candidates;
- duplicate, stale-generation, restart, unknown-charge, and budget-rotation
  tests;
- real Manito provider ledger, candidate, contact, and publication evidence;
- frontend shows exactly 10 persisted items after restart.

### Checkpoint 4: Fixed Pool, Archive, And Refresh

Goal: make the Recommendation Pool a user-controlled batch workflow.

Required implementation:

- Opportunity, skip, reject, or review state changes remain on the current
  fixed generation and trigger no one-for-one refill;
- `Archive current generation` performs archive only;
- `Generate next generation` is available only in `awaiting_refresh`;
- `Archive and generate next generation` is one explicit user command with
  idempotent generation-scoped execution;
- the next generation excludes current and historical project domains.

Verification:

- command-count and outbox assertions prove archive-only has zero provider
  side effects;
- repeated click/refresh/restart reuses the same operation;
- desktop and mobile UAT prove the lifecycle and visible history.

### Checkpoint 5: Opportunity And Real AI Draft

Goal: convert one accepted recommendation into an outreach-ready Draft.

Required implementation:

- preserve the selected recommendation in its generation;
- create one project-scoped Opportunity from verified contact evidence;
- generate one real structured Draft from project, target-site, recipient, and
  evidence inputs;
- validate schema, semantic relevance, claims, recipient, and project identity;
- persist model-run provenance and immutable Draft Versions;
- allow the user to edit and approve the exact version used by preflight.

Verification:

- no duplicate Opportunity or Draft Job after retry/reload;
- real provider/model-run evidence is labeled separately from local tests;
- the visible Draft contains no wrong project, product, target site, or
  unsupported claim.

### Checkpoint 6: Gmail Send Ready

Goal: stop exactly one click before a real Gmail send.

Required implementation:

- bind the selected project to an active tenant-scoped Gmail connection;
- run configured-runtime, Worker, send capability, recipient, approval,
  suppression, quota, and immutable-snapshot preflight;
- show the exact missing gate whenever preflight fails;
- keep Mail Center healthy in `waiting_for_accepted_send` before the send;
- require the user's current final confirmation before dispatch.

Exit:

```text
gmailConnection=CONNECTED
gmailSendCapability=AVAILABLE
gmailSyncCapability=AVAILABLE
workerMode=normal
approvedDraftVersion=true
finalPreflight=PASS
realGmailSendCount=0
status=SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION
```

Post-send cursor establishment, sent-message visibility, and reply sync MUST be
covered by automated/integration tests. Real send/reply evidence remains a
separate user-authorized action after this task's stop point.

### Checkpoint 7: Restart, Isolation, And Human UAT

Goal: prove that the complete workflow survives normal product use.

Verification:

- rebuild and restart without stale source/dist or Worker build identity;
- all required business consumers run in normal mode;
- Manito state remains correct after browser refresh and service restart;
- a second arbitrary project cannot see or reuse Manito recommendations,
  Resource Library eligibility, Opportunities, Drafts, Gmail binding, or mail;
- the user completes desktop product audit from Website Project through the
  final-send screen;
- result evidence records code, tests, runtime, real provider, and human UAT as
  separate categories.

## 6. Result Status Contract

The result document MUST use one of these exact statuses:

```text
PLANNED_NOT_STARTED
IN_PROGRESS
BLOCKED
READY_FOR_HUMAN_UAT
PASS_WITH_EXTERNAL_ACTION
PASS
```

- `READY_FOR_HUMAN_UAT`: implementation and bounded provider work are ready,
  but the user has not approved the exact Draft Version.
- `PASS_WITH_EXTERNAL_ACTION`: the full requested product state is proven and
  the only remaining action is the user's final Gmail send confirmation.
- `PASS`: may be used only if the user separately authorizes the send and the
  real sent-message/sync evidence also passes.
- Fewer than 10, template-only AI, Gmail `CONNECTED` without preflight, a
  quiesced Worker, or hidden Mail Center failure is `BLOCKED`.

## 7. Conflict And Collision Control

Current planning audit:

```text
worktreeEntries=328
gitUnmergedFiles=0
mergeConflictBlocker=false
semanticCollisionRisk=HIGH
normativeFixedGenerationTarget=10
currentImplementationDefaultTarget=20
implementationTargetMigrationRequired=true
```

The 10-item decision is documented but not yet implemented. Checkpoint 3 MUST
remove the current 20-item defaults from these active product surfaces:

```text
backend/core/src/modules/backlinks/db/migrations/0059_backlink_recommendation_pool_generations.sql
backend/core/src/modules/backlinks/application/queries/recommendations.query.ts
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
backend/core/test/backlinks/api/recommendations-route.test.ts
backend/core/test/backlinks/integration/recommendation-pool-generation.command.test.ts
backend/api/tests/test_backlinks_gateway.py
frontend/test/support/outreach-api-fixtures.ts
```

If migration `0059` has not been applied to any governed environment, update
its uncommitted default consistently. If it has been applied, preserve it and
add a forward migration that changes the policy/default to 10. Never rewrite
applied migration history.

High-collision surfaces include:

```text
backend/core/src/modules/backlinks/runtime/local-product-gmail-sync-runtime.ts
backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-publication.service.ts
backend/core/src/modules/backlinks/application/commands/recommendations.command.ts
backend/core/src/modules/backlinks/api/recommendation-commands.route.ts
backend/api/app/api/routes/backlinks.py
backend/contracts/openapi/backlinks.v1.json
frontend/src/api/generated/backlinks.ts
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
frontend/src/features/outreach/mail/mail-center.tsx
```

Execution rules:

1. Do not reset, clean, checkout, or revert the inherited tree.
2. Do not run parallel coding agents against these shared files.
3. Read and classify the existing diff before modifying a hotspot.
4. Stabilize backend schemas/routes before regenerating OpenAPI and the
   frontend client.
5. Regenerate the client once after backend contract stabilization, then run
   the generated-client check.
6. Treat migrations as append-only. Do not renumber or rewrite an applied
   migration; audit `0059` before changing its 20-item default or adding a
   forward 10-item migration.
7. Keep provider switches independent. A DataForSEO problem must not disable
   Gmail, and a Gmail problem must not corrupt recommendation progress.
8. Stop and record a concrete blocker if an inherited change cannot be safely
   adopted. Do not mask it with a replacement implementation.

The current tree has no Git merge conflict, so coding is not blocked at plan
time. The main risk is semantic collision with unfinished 018-038 work; the
serial checkpoint order above is the mitigation.

## 8. Required Result Evidence

`docs/execution/WEBSITE-PROJECT-V3-E2E-001-result.md` MUST contain:

- exact Start Card and stop boundary;
- inherited-change manifest and conflict audit;
- changed-file list by checkpoint;
- focused test commands and exact counts;
- migrations, OpenAPI, generated-client, typecheck, lint, build, and browser
  evidence;
- runtime identity, mode, consumer, and provider-capability evidence;
- DataForSEO cycles, paid calls, actual/unknown cost, cursors, and 10 published
  domains;
- Resource Library contribution count without exposing global inventory to the
  ordinary project UI;
- Opportunity, contact, AI model-run, Draft Version, and semantic validation
  evidence;
- Gmail connection, Send Ready, Sync state, Mail Center response, and exact
  missing-gate evidence;
- explicit `realGmailSendCount`;
- restart, idempotency, project isolation, desktop/mobile, and human UAT
  evidence;
- remaining external action and final status.

Evidence labels MUST distinguish:

```text
IMPLEMENTED
TESTED
RUNTIME_VERIFIED
REAL_PROVIDER_VERIFIED
HUMAN_UAT_VERIFIED
BLOCKED
INPUT_REQUIRED
```

Source code, fixtures, HTTP 200, build identity, or generated clients MUST NOT
be substituted for real-provider or human-UAT evidence.

## 9. Explicit Stop Rule

Execution stops when either:

1. every checkpoint passes and the product is
   `SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION`; or
2. a real blocker is recorded with exact evidence and the smallest next action.

At the stop point:

- do not send Gmail without the user's current confirmation;
- do not start another numbered task;
- do not commit or push without separate authorization;
- do not clear project/provider history to manufacture a clean result.
