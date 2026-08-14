# LOCAL-PRODUCT-038 Result

> Historical result. Counts and conclusions below describe the 038 run and are
> not rewritten. The active task is `WEBSITE-PROJECT-V3-E2E-001`, whose current
> fixed generation target is 10.

## Task Start Card

```text
task=LOCAL-PRODUCT-038
authoritativeInstruction=C:\Users\DELL\Documents\缝合\GrowthOS-任意Website-Project真实闭环最终Coding指令手册-V3.0-2026-08-12.md
normativeContract=backend/core/docs/execution/LOCAL-PRODUCT-038-website-project-real-closure-contract.md
skill=C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md
repository=C:\Users\DELL\Documents\缝合\john3947-seo
result=backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-038-result.md
stopPoint=SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION
dataForSeoCycleMicros=1000000
dataForSeoMaxPaidCallsPerCycle=250
gmailSendCeiling=0_without_current_human_confirmation
commit=false
push=false
```

## Final Status

```text
status=BLOCKED
passLocalProduct=false
realProviderVerified=PARTIAL
nonCandidatePath=PASS_CODE_PROVIDER_INPUT_REQUIRED
candidateDiscoveryPausedByUser=true
gmailConnectionAndSyncRuntimeVerified=true
gmailSendReady=false
gmailSendCount=0
remainingHumanAction=APPROVE_EXACT_DRAFT
fullOutreachOutcomeProven=false
nextNumberedTaskStarted=false
```

`LOCAL-PRODUCT-038` is not accepted. The exact Manito Silk first pool contains
6 publishable recommendations, not the required 20. The governed supply path
reached a persisted supply-floor terminal state after repeated complete
zero-raw rounds. The contract explicitly forbids converting this shortage into
a PASS.

The user explicitly paused candidate work and authorized the remaining
non-candidate path. That continuation created one Opportunity, generated and
persisted one real schema-valid AI draft, and verified the selected Gmail
connection and polling-sync runtime. It stops before draft approval, immutable
send-snapshot creation, final preflight, or any Gmail send.

The consume-one/refill-to-20 checkpoint remains unproven. The overall gate
therefore remains `BLOCKED` even though the non-candidate path has advanced to
`APPROVE_EXACT_DRAFT`.

## Acceptance Project

```text
websiteProjectId=3778023d-05a4-442d-babf-5424ae30f094
projectKey=manitosilk-com-3778023d
name=Manito Silk
canonicalDomain=manitosilk.com
organizationId=11111111-1111-4111-8111-111111111111
workspaceId=cec65d3f-92e5-4b13-aa26-7b39e74e213a
projectContextVersionId=3432a635-5729-4dc8-aca0-fdcd62852958
```

The project was created through the product path. No SQL business-state write,
project-specific branch, domain special case, manual recommendation insertion,
or preloaded project inventory was used to make it pass.

## Exact First-Pool Evidence

```text
requiredPublishableCount=20
actualPublishableCount=6
inventoryTotal=11
publishedFitEligibleContactEligiblePublicEmailReady=6
notPublishedFitEligibleManualReviewNoVerifiedEmailReady=5
checkpoint1=FAIL
```

The counted six rows all have:

```text
publication_status=PUBLISHED
fit_decision=eligible
contact_decision=eligible
verified_public_email_count=1
status=ready
```

The inventory policy persisted:

```text
refillState=exhausted
pauseReason=tiers_exhausted
terminationReason=TIERS_EXHAUSTED
currentRefillRound=30
lastPublishableCount=6
lastRawCandidateCount=387
updatedAt=2026-08-12T17:31:43.806Z
```

Rounds 27, 28, and 29 each contain 12 attempts across all six tiers and both
windows, with `rawTotal=0` and `eligibleTotal=0`. Round 30 was interrupted by
the new evidence-based terminal decision after the prior consecutive complete
zero-raw rounds were recognized.

## Defects Reproduced And Fixed

### Unbounded refill rounds

The live workflow reached round 30 even though complete prior rounds contained
no raw candidates. The refill planner now returns
`SUPPLY_FLOOR_REACHED` after two consecutive complete rounds in which all six
tiers and both windows report zero raw candidates.

This is an evidence-based terminal condition, not an arbitrary maximum-round
constant.

### Duplicate refill after terminal supply floor

After the first terminal refill job completed, the scheduler created a second
refill job for the same project/context:

```text
firstTerminalJob=3b55d8c3-2fa0-44d2-a37d-e3aff17551e7
duplicateTerminalJob=fa2fe928-d95a-4b9c-96af-f922bbdf560a
outcome=SUPPLY_FLOOR_REACHED
publishedCount=6
targetPublishedCount=20
```

The refill service now treats persisted `TIERS_EXHAUSTED` as terminal and
returns `paused/tiers_exhausted` instead of creating another job. After the
fix and final quiesced rebuild, the database contains zero jobs created after
the duplicate terminal job timestamp.

### Scheduling priority

Recommendation scheduling now orders active scopes by newest project-context
creation time first, then inventory count. Once the selected scope has queued
or pending refill work, the scheduling lane stops instead of advancing another
scope in the same scan.

This reduces cross-project competition but did not prove full isolation from
already-running Temporal workflows; see the isolation failure below.

## Changed Files

- `backend/core/src/modules/backlinks/domain/recommendations/commercial-refill-cycle.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-inventory-refill.service.ts`
- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
- `backend/core/test/unit/commercial-refill-cycle.test.ts`
- `backend/core/test/unit/commercial-inventory-refill.test.ts`
- `backend/core/test/unit/production-runtime.test.ts`
- `backend/core/src/modules/backlinks/runtime/local-product-ai-runtime.ts`
- `backend/core/test/unit/local-product-ai-runtime.test.ts`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-038-result.md`

The worktree already contained substantial unrelated and concurrent changes.
Only the specific behaviors described above are claimed by this result. In the
continuation, the AI credential resolver was aligned with the fixed
`local-product` import context and a focused regression test was added. The
existing AI runtime file also contains concurrent changes that are not claimed
as part of that fix.

The local runtime environment files
`C:\Users\DELL\AppData\Local\GrowthOS\live001\backlinks-api.env` and
`C:\Users\DELL\AppData\Local\GrowthOS\live001\backlinks-worker.env` now set
`AI_PROVIDER_MAX_INPUT_TOKENS=20000`; no secret value is recorded here.

## Verification

```text
commercialInventoryRefillTests=11/11 PASS
commercialRefillCycleAndProductionRuntimeTests=19/19 PASS
commercialSupplyProjectIsolationDataForSeoRuntimeTests=14/14 PASS
focusedTestsTotal=44/44 PASS
typecheck=PASS
focusedEslint=PASS
coreBuild=PASS
browserWorkerBuild=PASS
frontendBuild=PASS
migrations=PASS through 0058
continuationCoreTests=46/46 PASS
continuationFrontendTests=14/14 PASS
continuationDiffCheck=PASS
manualProductUiVerification=PASS
```

One parallel Vitest attempt failed to start a Windows worker with
`spawn UNKNOWN`. The same files were rerun serially with one worker and all 44
focused tests passed; there was no assertion failure.

The continuation Core run covered AI runtime/import, draft generation and
polling, draft APIs, send-intent routing, and Gmail send-intent command
behavior. The frontend Node run covered draft source/editor/polling and Gmail
source behavior. The ordinary Manito Silk UI was also inspected for the
recommendation, Opportunity, draft-review, and Gmail status projections.

## Final Runtime

The final continuation restart completed on `2026-08-13` with run ID
`20260813-081304`.

```text
runtimeStatus=maintenance_ready
workerExecutionMode=quiesced
businessConsumersRunning=false
buildMatches=true
apiBuildId=local-product-76c963f0d84d612810993f0f
workerBuildId=local-product-76c963f0d84d612810993f0f
sourceFingerprint=76c963f0d84d612810993f0f7298e07d4033f8af53282f3846bb5156a2d50982
artifactFingerprint=ec9e2629f5eb3fa9af8253124b61e83c712ee9aae65ed37e6e8db22d88b0f640
frontendHttp=200
fastApiHttp=200
privateCoreHttp=200
browserWorkerEnabled=false
postgresReady=true
temporalReady=true
dataForSeoEnabled=false
aiEnabled=true
gmailSendEnabled=true
gmailSyncEnabled=true
```

Provider capabilities remain independently configured, but the quiesced Worker
does not run business consumers. The status scanner reported recent FastAPI log
matches caused by aborted browser requests/restart transitions; the current
Frontend, FastAPI, and Core endpoints all returned HTTP 200.

## DataForSEO Evidence

Manito Silk accumulated the following settled usage across two governed budget
cycles:

| Cycle | Settled ledger entries | Actual micros | Cycle call ceiling | Cycle micros ceiling |
| --- | ---: | ---: | ---: | ---: |
| `93396ba5-75f1-47b4-ae82-3b640b6ee442` | 225 | 185400 | 250 | 1000000 |
| `5b695141-2075-4f10-b649-a3887a6fc224` | 110 | 93000 | 250 | 1000000 |

```text
targetSettledLedgerEntries=335
targetActualCostMicros=278400
targetUnknownChargeCount=0
targetNewLedgerEntriesAfter2026-08-12T17:25:00Z=0
targetNewActualCostMicrosAfter2026-08-12T17:25:00Z=0
```

Each individual cycle stayed within the configured 250-call and
1,000,000-micros ceilings. Historical provider batch rows include 334
successful requests and 107 failed requests; one failed request had a settled
charge, which is why settled ledger entries total 335.

Candidate execution is now paused:

```text
dataForSeoEnabled=false
newManitoLedgerEntriesAfterPause=0
newManitoActualCostMicrosAfterPause=0
```

The GrowthOS internal DataForSEO budget was not exhausted. The current runtime
status also exposes a separate active configured cycle with
`spentMicros=94200`, `reservedMicros=27600`, and
`remainingMicros=878200`. These are internal governance figures, not the
official external DataForSEO account balance; that external balance was not
queried.

## Project-Isolation Failure

The bounded normal-Worker window also advanced already-running workflows for
other projects. This is not accepted as project isolation.

```text
smileTvProjectId=49a2fc1e-a84b-4794-b3a9-131710c8702d
smileTvNewFailedBatchRows=2
smileTvRequestCount=2
smileTvEstimatedMicros=55200
smileTvActualMicros=0
smileTvProviderTaskIds=0
smileTvJobStep=paused_provider

elephTvProjectId=e0bfde33-54bd-454a-ab61-cf7a4a48dcf0
elephTvJobStep=provider_request_failed
elephTvProviderCallOccurred=false
```

The two SmileTV batch rows failed under the DataForSEO kill-switch path and did
not create usage-ledger entries or provider task IDs. No actual charge was
recorded, but the state transitions still violate the intended acceptance
isolation boundary. No manual SQL repair or rollback was applied.

## AI And Gmail

```text
manitoOpportunities=1
manitoDrafts=3
manitoDraftVersions=1
manitoModelRuns=3
manitoSuccessfulModelRuns=1
successfulModelRunCostUsd=0.001417
manitoSendIntents=0
manitoSendSnapshots=0
manitoSendAttempts=0
gmailSendCount=0
```

The selected published recommendation for `juliannarae.com` became Opportunity
`50465db4-6cbd-4646-af1b-f472492a68ec`.

Three immutable model-run audit records exist:

1. `958cbbee-6119-4b67-bb3f-95336d10452f` failed closed with
   `MISCONFIGURED` before a provider call because the fixed credential was
   resolved with the wrong organization context.
2. `375a62b6-1abc-4a85-9370-c93074bc6f0c` reached the real provider but
   failed with `BUDGET_EXCEEDED` when the returned input-token count exceeded
   the former `8000` runtime limit. The failure row does not retain provider
   usage or cost, so any provider charge for this failed attempt is
   unobservable and is not claimed as zero.
3. `dda3106c-5c47-4c3d-8b12-964e51a447ad` succeeded with provider
   `openai`, model `gpt-5.6-sol`, model version `2026-08-03`, 10014 input
   tokens, 693 output tokens, and recorded cost `USD 0.001417`.

The successful result produced draft
`78057712-37ff-4771-b757-141d10b9bdb3`, version
`76110e5f-47ab-40f5-8eec-f602c122754b`:

```text
status=draft
approvedVersionId=null
source=MODEL
requiresUserConfirmation=true
canAutoSend=false
subject=A practical silk-pajama content idea for juliannarae.com
```

Exact body awaiting human approval:

```text
Hello,

I’m reaching out on behalf of Manito Silk, a US-focused site featuring silk pajamas at https://manitosilk.com/. I noticed that juliannarae.com also covers pajamas and silk sleepwear, including dedicated product and fabric information, so there appears to be a relevant overlap for readers interested in silk garments.

I’d like to explore a content partnership around a concise educational piece on selecting and caring for silk pajamas. Manito Silk could contribute practical input for the piece, while your team would retain full editorial control over the subject, format, and final wording. Where useful to readers and consistent with your editorial policy, the piece could reference Manito Silk as an additional resource.

Would you be open to reviewing a brief outline with a few possible angles? If this is not a current priority, no problem at all. A short reply indicating whether this type of collaboration is relevant would be appreciated.

Best,
The Manito Silk team
```

The selected Manito mailbox binding exists and is active. Connection
`ce7b81a9-9023-4a0b-a1ba-371dca9fc737` is `CONNECTED`, has
`send_availability=AVAILABLE`, has Gmail send and readonly scopes, exposes one
verified send identity, and has mail-sync capability enabled. The UI and API
project the polling state as `WAITING_FOR_ACCEPTED_SEND`, with zero accepted
sends, no History cursor, no sync failure, and the project Gmail Sync Kill
Switch open.

These facts do not establish final Gmail Send Ready. The draft is not approved,
and no immutable send snapshot, send intent, final-review acknowledgement, or
final preflight exists.

No Gmail message was sent. The current user instruction to continue all
non-candidate work is not approval of the exact subject/body and is not final
send confirmation.

## Scope And Stop Audit

```text
onlyNamedTaskExecuted=LOCAL-PRODUCT-038
task039Started=false
candidateDiscoveryPaused=true
dataForSeoEnabled=false
actualGmailSend=false
manualSqlBusinessMutation=false
manualProviderLedgerMutation=false
commit=false
push=false
finalWorkerMode=quiesced
```

The long runtime was initially caused by an unbounded refill loop and a
duplicate terminal refill job. The continuation then exposed two separate AI
runtime failures before the persisted real-provider draft succeeded. The
remaining delay is not a provider wait: it is the required human-control
boundary.

Execution stops at `HUMAN_DRAFT_APPROVAL_REQUIRED`. After explicit approval of
the exact draft, the next permitted continuation is approval persistence,
immutable snapshot/send-intent preflight, and another stop at
`SEND_READY_WAITING_FOR_HUMAN_CONFIRMATION`. Actual Gmail send still requires
a separate explicit final confirmation.

Even if that downstream path is completed, full `LOCAL-PRODUCT-038` acceptance
remains `BLOCKED` until the paused candidate requirement proves an exact first
pool of 20 and consume-one/refill-to-20 behavior. `LOCAL-PRODUCT-039` was not
started. No commit or push was performed.

## 2026-08-13 User-Visible Draft Correction

The earlier UI wording was too broad. It proved that the persisted draft detail
route could render, but it did not prove that the user's already-open New Draft
page had navigated to that route.

The user-provided screenshot showed a background-processing rejection while the
business Worker was intentionally quiesced. The existing persisted draft was
then opened and reloaded through the actual product UI at:

```text
http://localhost:5173/projects/manitosilk-com-3778023d/backlinks/drafts/78057712-37ff-4771-b757-141d10b9bdb3
```

The read-only UI verification showed:

```text
existingPersistedDraftVisible=PASS
status=draft
approvedVersionId=null
backendVersion=v2
source=MODEL
subjectVisible=true
bodyVisible=true
inlineBackgroundProcessingErrorAfterReload=false
globalMaintenanceBanner=true
```

The inline error from the screenshot did not reproduce after a read-only reload.
The exact rejected request that produced the screenshot was not captured, so no
more specific cause is claimed. The remaining global maintenance banner is
expected while the Worker stays quiesced.

The New Draft page remained `IDLE` because this manual acceptance run used
logical key `local-product-038-manito-juliannarae-initial-v3`, while the normal
product flow restores only the standard key
`initial-outreach:<opportunityId>:<contactId>`. No fuzzy key lookup, database
repair, or product special case was added to conceal that distinction.

This correction caused zero new AI calls, zero DataForSEO calls, zero candidate
discovery, zero draft approval, and zero Gmail sends. The user-visible draft
detail is verified; the human approval stop and the paused candidate acceptance
debt remain unchanged.

## 2026-08-13 Human Approval Unavailable Repair

The user then reproduced the same maintenance rejection from the `人工批准`
action. This was a real product defect, not a missing draft.

Two independent approval-path defects were found and repaired:

1. The FastAPI maintenance guard rejected every non-safe request while the
   business Worker was quiesced. Draft approval and send preflight are
   synchronous Core operations, so they must not depend on background
   consumers. The guard now allows only:
   - `POST .../drafts/:draftId/approve`
   - `POST .../drafts/:draftId/send-preflight`
2. The Core approval query used `FOR UPDATE OF d,c,v`. The immutable
   `backlink_draft_versions` table intentionally grants no `UPDATE` privilege
   to `growthos_backlinks_writer`, so locking alias `v` caused PostgreSQL
   `42501`. The query now locks only mutable draft and contact rows with
   `FOR UPDATE OF d,c`. No privilege was broadened.

The asynchronous send-intent endpoint was deliberately not exempted. It still
returns `BUSINESS_CONSUMERS_UNAVAILABLE` while the Worker is quiesced.

### Changed Files For This Repair

- `backend/api/app/api/routes/backlinks.py`
- `backend/api/tests/test_backlinks_gateway.py`
- `backend/core/src/modules/backlinks/application/repositories/draft-generation.repository.ts`
- `backend/core/test/backlinks/integration/draft-migration.test.ts`
- `frontend/src/App.tsx`
- `frontend/src/runtime-status-source.test.mjs`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-038-result.md`

These files already contained concurrent work. Only the maintenance exception,
approval row-lock correction, focused regression tests, and maintenance-banner
wording described here are claimed.

### Focused Verification

```text
gatewayMaintenanceTests=2/2 PASS
coreDraftMigrationIntegrationTests=9/9 PASS
frontendRuntimeStatusSourceTest=1/1 PASS
frontendTypecheck=PASS
focusedFrontendEslint=PASS
focusedDiffCheck=PASS
```

The Core integration regression test executes approval under
`growthos_backlinks_writer`, proves that role has no `UPDATE` privilege on
`backlink_draft_versions`, and verifies approval succeeds without locking the
immutable version row.

### Live No-Side-Effect Verification

```text
approveWithExpectedVersion999999=HTTP_409_BACKLINK_CONFLICT
sendPreflightWithEmptyBody=HTTP_400_BACKLINK_INVALID_REQUEST
sendIntentWhileWorkerQuiesced=HTTP_503_BUSINESS_CONSUMERS_UNAVAILABLE
draftStatus=draft
draftVersion=2
approvedVersionId=null
sendIntentCount=0
sendAttemptCount=0
newAiCalls=0
newDataForSeoCalls=0
newGmailSends=0
```

The invalid expected version proves the approval request reaches the Core
conflict path without approving the draft. The product UI was reloaded after
the repair and showed the persisted MODEL draft, status `待审批`, and an enabled
`人工批准` button with no inline approval error.

The global maintenance banner was corrected from the false statement that only
reads remain available to:

```text
后台任务处理已暂停
读取、草稿人工批准和发送前检查仍可用；新建项目、后台任务和实际发送暂不可用。
```

### Current Runtime And Send Boundary

```text
runtimeStatus=maintenance_ready
runId=20260813-095202
workerExecutionMode=quiesced
businessConsumersRunning=false
dataForSeoEnabled=false
aiEnabled=false
gmailSendEnabled=false
gmailSyncEnabled=false
```

The restart that loaded the approval repair used the verified Core build but
did not preserve the AI/Gmail switches. A scoped attempt to restore those
switches was stopped by build-identity protection. The required full Core
rebuild currently fails on seven type errors in concurrent candidate-pool
generation work involving `visiblePoolGeneration` and `archivePool`.

Those candidate modules are outside this approval repair and candidate work is
explicitly paused by the user. They were not repaired, reverted, or bypassed.
The running approval path remains available, but current Gmail Send Ready is
false and actual sending remains unavailable.

Execution remains stopped at `HUMAN_DRAFT_APPROVAL_REQUIRED`. Clicking
`人工批准` may now persist approval, but it does not send mail. Restoring a
verified Gmail-enabled runtime, completing send preflight, creating the
immutable send snapshot/intent, and obtaining a separate explicit final send
confirmation are still required before any real Gmail send.

No commit or push was performed.

## 2026-08-13 Project-Wide Blueprint V3 And Fixed-Generation Amendment

The recommendation behavior is now defined independently from the 038
acceptance project by the project-wide normative architecture:

`docs/architecture/website-project-recommendation-blueprint-v3.md`

The architecture applies to every current and future Website Project. It
defines:

- immutable project-derived Blueprint V3 inputs and evidence;
- five progressive paid-discovery tiers plus the hidden project-matched
  Resource Library lane;
- adaptive sample sizing and durable `(generation,tier,round,window)` cursors;
- soft thresholds that may widen and hard gates that may never be relaxed;
- exactly 20 published, project-relevant, contact-ready items per generation;
- a fixed `active` user workset with no one-for-one refill;
- archive-only transition to `awaiting_refresh` with zero refill side effects;
- explicit user initiation of generation 2 and later;
- generation-scoped Jobs, candidates, inventory, idempotency, and frontend
  operation sessions;
- prohibited named-project/domain branches and stale-generation writes.

The following important documents now reference the same authority:

- `backend/core/docs/execution/LOCAL-PRODUCT-038-website-project-real-closure-contract.md`
- `ops/local-product/LOCAL-PRODUCT-runbook.md`
- `docs/SEO自动化平台-UIUX需求文档-V1.2.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`
- `C:\Users\DELL\Documents\缝合\GrowthOS-任意Website-Project真实闭环最终Coding指令手册-V3.0-2026-08-12.md`

The UI/UX contract no longer says that Opportunity creation removes a
recommendation or refills one replacement. It now requires a stable 20-item
generation, whole-generation archive, `awaiting_refresh`, and explicit next
generation.

### Verification

```text
backendFocusedTests=8 files / 53 tests PASS
backendFocusedEslint=PASS
backendTypecheck=PASS
backendProductionBuild=PASS
postgresqlGenerationLifecycleIntegration=PASS
gatewayAndMigrationTests=29 PASS
frontendRecommendationSourceTests=13 PASS
frontendTypecheck=PASS
frontendFocusedEslint=PASS
frontendPrettier=PASS
frontendProductionBuild=PASS
desktopFixedGenerationE2E=2/2 PASS
gitDiffCheck=PASS
```

The desktop tests prove:

1. generation 1 creates one server refill operation and reconnects to the same
   operation across navigation and browser refresh;
2. the completed generation displays 20 recommendations;
3. moving an item to Opportunity leaves it in the current pool and creates no
   refill request;
4. archive-only moves to `awaiting_refresh` and creates no refill request;
5. `Generate next generation` explicitly starts generation 2 and reuses the
   generation-scoped operation identity.

### Provider And Stop Boundary

```text
realDataForSeoCalls=0
realAiCalls=0
realGmailCalls=0
realGmailSends=0
commit=false
push=false
nextNumberedTaskStarted=false
```

Source, migration, contract, database lifecycle, build, and local browser
behavior are verified. A real arbitrary-project run that reaches 20 through
live DataForSEO/contact processing, a real AI Draft, Gmail Send Ready, and
human UAT remain separately labeled external acceptance evidence. This
amendment does not convert missing real-provider evidence into a product PASS.
