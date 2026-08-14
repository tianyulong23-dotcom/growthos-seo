# WEBSITE-PROJECT-V3-E2E-002 Execution Manual

> Effective date: `2026-08-13`
>
> Status: `PLAN_READY_NOT_STARTED`
>
> Acceptance input: one user-selected public website not previously imported
> into the acceptance environment
>
> Product scope: every current and future Website Project

## 1. Task Start Card

```text
taskId=WEBSITE-PROJECT-V3-E2E-002
repository=C:\Users\DELL\Documents\缝合\john3947-seo
skill=C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md
normativeArchitecture=docs/architecture/website-project-recommendation-blueprint-v3.md
instruction=docs/execution/WEBSITE-PROJECT-V3-E2E-002-execution-manual.md
result=docs/execution/WEBSITE-PROJECT-V3-E2E-002-result.md
acceptanceWebsite=USER_INPUT_REQUIRED_FRESH_PUBLIC_WEBSITE
acceptanceMarket=DERIVE_THEN_CONFIRM
acceptanceCategory=DERIVE_THEN_CONFIRM
acceptanceLanguage=DERIVE_THEN_CONFIRM
fixedGenerationTarget=10
initialStopPoint=FINAL_GMAIL_SEND_CONFIRMATION_REQUIRED
conditionalFinalStop=REAL_SEND_AND_SENT_SYNC_VERIFIED
commit=false
push=false
```

This is a new full-workflow product revalidation task. It does not resume
`LOCAL-PRODUCT-038`, and it does not inherit a pass from
`WEBSITE-PROJECT-V3-E2E-001`, Manito rows, historical recommendations,
Opportunities, Drafts, Gmail messages, manual repairs, or provider calls.

The acceptance website must be a genuinely fresh project input. Manito Silk,
SmileTV, AWOL, and ElephTV remain regression controls only. Their existing data
must not contribute to this task's product pass.

## 2. Objective

Starting from the ordinary frontend and one fresh website URL, prove this
complete product workflow:

```text
create Website Project
-> persist project Context and Settings
-> derive project-specific Blueprint V3
-> generate generation 1 with exactly 10 recommendations
-> review the fixed pool without one-for-one refill
-> move one selected recommendation to Opportunity
-> archive generation 1
-> explicitly generate generation 2 with exactly 10 new domains
-> generate and approve a real evidence-grounded AI Draft
-> bind the selected project to Gmail
-> reach Send Ready with healthy pre-send synchronization
-> stop for the user's current final confirmation
-> send exactly one real outreach email
-> synchronize the sent message into Mail Center
-> survive refresh and service restart without duplication or project leakage
-> remain ready to synchronize a real reply when the recipient responds
```

The task validates a product capability, not one named demo. Any implementation
or acceptance evidence that depends on the selected project's name, domain,
IDs, pre-existing inventory, or manual database edits is a failure.

## 3. Definition Of Done

The task is complete only when all mandatory statements below are true:

1. The acceptance Website Project is created through the normal frontend and
   did not exist before the task.
2. Its Context, Settings Version, Blueprint, provider requests, candidates,
   contacts, generations, Opportunities, Drafts, Gmail binding, and messages
   are project-scoped and persisted.
3. Generation 1 becomes `active` only at exactly 10 unique, relevant,
   contact-ready, publicly reachable recommendations.
4. The ordinary user cannot browse the global Resource Library. Resource
   inventory contributes only after project-specific evaluation and
   publication.
5. Moving one item to Opportunity leaves the visible generation fixed at 10
   and creates zero replacement Jobs or provider calls.
6. Archive-only archives the whole generation and creates zero provider work.
7. Generation 2 starts only after an explicit user command, reaches exactly 10,
   and contains no domain from generation 1 or the project's earlier history.
8. The selected Opportunity persists after generation 1 is archived.
9. A configured AI provider produces a schema-valid, semantically relevant,
   evidence-grounded Draft with `generationMode=MODEL`. A template or
   deterministic fallback does not satisfy this requirement.
10. The user reviews and approves the exact immutable Draft Version used by
    final preflight.
11. Gmail `CONNECTED`, Send Ready, and Sync Ready are independently truthful.
    The pre-send Mail Center state is `waiting_for_accepted_send`, not an
    unexplained blank page, spinner, timeout, or false sync failure.
12. No stale Gmail polling workflow produces an unregistered-activity loop in
    the acceptance runtime. Maintenance or quiesced state is shown honestly.
13. The task sends zero messages before the user's current final confirmation.
14. After confirmation, exactly one Send Intent and one accepted provider send
    occur for the approved Draft Version. Replay cannot create a second send.
15. Mail Center persists the sent message, provider message identity, thread
    identity, and synchronization cursor for the selected project.
16. Browser refresh, repeated clicks, project switching, frontend restart,
    API restart, and Worker restart do not duplicate or lose accepted state.
17. A second project and another tenant cannot read or reuse the acceptance
    project's recommendations, Resource Library eligibility, Opportunities,
    Drafts, Gmail binding, or messages.
18. Desktop and mobile human UAT cover the complete visible workflow.
19. Source, test, runtime, real-provider, and human-UAT evidence are recorded
    separately in the result artifact.

A real reply is controlled by the recipient, not by GrowthOS. If no reply has
arrived by the end of the bounded observation window, the task may stop at
`PASS_WITH_EXTERNAL_ACTION` only after real send and sent-message sync pass.
The remaining external action must be recorded as `RECIPIENT_REPLY_PENDING`.
If a reply arrives, the task must also prove project-scoped reply ingestion,
thread association, deduplication, and restart persistence before using
`PASS`.

## 4. Scope And Prohibited Shortcuts

### Allowed

- the smallest generic code repair required by a failed current checkpoint;
- focused tests added before or with that repair;
- read-only database and provider-ledger inspection;
- supported product commands, migrations, runtime restarts, and governed
  provider recovery;
- adoption of compatible inherited 018-038 changes after inspecting their
  diffs;
- regeneration of OpenAPI and frontend clients after backend contracts
  stabilize.

### Prohibited

- continuing `LOCAL-PRODUCT-038` or changing its result to manufacture a pass;
- using Manito's completed 10 rows as acceptance inventory;
- project-name, domain, ID, or fixture-specific runtime branches;
- direct SQL insert/update/delete of acceptance business state;
- manually marking Jobs, Workflows, generations, contacts, drafts, sends, or
  sync rows complete;
- publishing fewer than 10 or lowering hard public-contact and safety gates;
- one-for-one refill after review, skip, reject, or Opportunity creation;
- auto-generating the next batch from page load, refresh, polling, or project
  switching;
- exposing the full Resource Library to ordinary users;
- counting raw candidates, Resource Library rows, template drafts, HTTP 200,
  typecheck, build identity, or historical provider work as product success;
- sending Gmail before the user's current confirmation;
- broad cleanup, unrelated refactors, commit, push, or deployment.

If a checkpoint fails, later checkpoints remain locked. Diagnose one root
cause, make one scoped generic repair, add a regression test, and rerun that
same checkpoint through the normal product path. Do not work on unrelated
symptoms while the current root cause is unresolved.

## 5. Provider And Side-Effect Ceiling

### DataForSEO

```text
cycleBudgetMicros=1000000
maxPaidCallsPerCycle=250
maxOpenCycles=1
maxSettledCyclesForTask=4
maxTaskBudgetMicros=4000000
cycleRotation=AUTOMATIC_ONLY_AFTER_PRIOR_CYCLE_SETTLES
unknownChargePolicy=RECONCILE_BEFORE_ROTATION
targetPerGeneration=10_PUBLISHED
```

The task may rotate a settled cycle without using budget exhaustion as a
reason to accept a partial pool. It must preserve provider history, cursors,
idempotency, actual cost, unknown cost, Kill Switch state, and all hard gates.
Exceeding the task ceiling requires a new explicit authorization; it does not
permit fake success or silent extra spend.

### AI

```text
maxRealBlueprintAttempts=2
maxRealDraftAttempts=3
templateFallbackCountsAsPass=false
```

### Gmail

```text
realSendsBeforeHumanConfirmation=0
maxRealSendsAfterHumanConfirmation=1
gmailConnectionRequired=true
gmailSendCapabilityRequired=true
gmailSyncCapabilityRequired=true
```

### Public Page Retrieval

```text
publicPageEvidenceRequired=true
browserProviderOptional=true
pageFetchesMustBeGovernedAndBounded=true
```

DataForSEO, AI, Gmail Send, Gmail Sync, and public page retrieval remain
independent capabilities. A failure in one must not disable or corrupt the
others.

## 6. Serial Checkpoints

Each checkpoint must be recorded in the result document before the next one
starts.

### Checkpoint 0: Input And Inherited-Work Gate

Goal: create a fresh, auditable acceptance boundary.

Actions:

- obtain the fresh website URL from the user;
- derive market, language, category, products, and likely audiences, then
  present the normalized input for confirmation before real provider work;
- record branch, HEAD, worktree count, unmerged files, runtime build identity,
  and provider capability state;
- prove the acceptance URL and canonical domain do not already exist as a
  Website Project in the acceptance environment;
- create an inherited-change manifest for every file touched by this task;
- classify inherited edits as `adopt`, `repair`, or `defer`;
- record provider-ledger, Job, Workflow, generation, Opportunity, Draft, send,
  and mail baselines before the first side effect.

Exit:

```text
freshAcceptanceDomain=true
unmergedFiles=0
inheritedHotspotsClassified=true
baselineCountersRecorded=true
realProviderCalls=0
```

### Checkpoint 1: Runtime And Gmail Health Gate

Goal: prevent a recommendation success from reaching another broken Mail
Center.

Required proof:

- API and Worker use the same current source/build identity;
- Worker is in normal mode with required business consumers running;
- Gmail Send and Gmail Sync capability states are explicit;
- current and historical polling workflows do not loop on
  `activity not registered`;
- pre-send Mail Center status completes within two seconds locally;
- a missing pre-send History cursor projects
  `waiting_for_accepted_send`;
- quiesced, disabled, configuration-error, and provider-error states are
  visible and do not show false elapsed processing.

No real Gmail send is allowed in this checkpoint.

### Checkpoint 2: Fresh Project Bootstrap

Goal: prove that normal project creation supplies everything downstream needs.

Actions:

- create the acceptance project from the frontend;
- persist immutable Context and Settings Versions;
- derive Blueprint V3 only from those persisted inputs;
- initialize generation 1 exactly once;
- refresh, navigate away, return, and restart once to prove persistence;
- scan active runtime code for named-project branches.

Exit:

```text
projectCreatedThroughFrontend=true
contextPersisted=true
settingsPersisted=true
blueprintProjectDerived=true
generation1InitializedOnce=true
```

### Checkpoint 3: Generation 1 Exact 10

Goal: build the first fixed Recommendation Pool through real governed supply.

Actions:

- consume project-eligible hidden Resource Library supply;
- run progressive Blueprint/DataForSEO discovery and contact convergence;
- persist tier, round, window, cursor, provider request, reservation, cost,
  candidate decision, contact evidence, and publication facts;
- remain `building` from 0 through 9;
- atomically publish and activate at exactly 10;
- prevent an 11th publication;
- show real progress or an exact pause reason.

Required runtime evidence for every published row:

```text
canonicalDomain
projectFitReason
sourceAndQuery
publicReachability
contactPurpose
publicRecipientEmail
contactEvidenceUrl
contactEvidenceConfidence
publicationDecision
generationNumber
```

### Checkpoint 4: Fixed Pool And Opportunity

Goal: prove the pool does not refill item by item.

Actions:

- select one recommendation through the frontend;
- move it to one project-scoped Opportunity;
- verify the recommendation remains visible in generation 1;
- verify the visible generation remains exactly 10;
- verify zero new refill Jobs, provider requests, reservations, ledger entries,
  or outbox dispatches;
- replay the command and refresh the browser to prove idempotency.

### Checkpoint 5: Archive And Generation 2

Goal: prove the user-controlled batch lifecycle.

Actions:

- execute `Archive current generation`;
- verify all generation 1 items become historical and no provider side effect
  occurs;
- verify the project enters `awaiting_refresh`;
- execute `Generate next generation` explicitly;
- verify one generation-scoped Job is created or resumed;
- build generation 2 to exactly 10;
- verify zero domain overlap with generation 1 and project history;
- verify the generation 1 Opportunity still exists and remains usable.

The combined UI command may orchestrate archive then generation startup, but
the durable evidence must still show two separate idempotent operations.

### Checkpoint 6: Real AI Draft

Goal: produce a sendable Draft from the selected Opportunity.

Actions:

- generate one real model Draft from the selected project's Context, target
  site, public contact, evidence, and cooperation angle;
- validate schema, semantics, claims, language, project identity, target
  identity, and recipient intent;
- persist model-run provenance and immutable Draft Versions;
- allow user edits without losing the original generated version;
- require the user to approve the exact version used by send preflight;
- prove retry and refresh do not create a duplicate Draft Job.

### Checkpoint 7: Gmail Send Ready And Human Gate

Goal: stop exactly one user confirmation before a real send.

Required exit:

```text
gmailConnection=CONNECTED
gmailSendCapability=AVAILABLE
gmailSyncCapability=AVAILABLE
workerMode=normal
approvedDraftVersion=true
recipientEvidenceValid=true
suppressionCheck=PASS
quotaCheck=PASS
immutableSnapshotReady=true
finalPreflight=PASS
mailCenterState=waiting_for_accepted_send
realGmailSendCount=0
status=FINAL_GMAIL_SEND_CONFIRMATION_REQUIRED
```

The user must inspect sender, recipient, subject, body, target project, and the
approved Draft Version in the frontend. Execution pauses here until the user
sends a new, explicit confirmation for this task and this exact Draft Version.

### Checkpoint 8: Exactly One Real Send

Authorization: locked until the user's current final confirmation.

Actions after confirmation:

- create one Send Intent from the approved immutable Draft Version;
- execute one Gmail provider send;
- persist provider acceptance, message ID, thread ID, attempt, quota, and
  delivery state;
- repeat the command, refresh, and retry the client once to prove no second
  provider send occurs;
- verify failures remain visible and resumable without fabricating acceptance.

Exit:

```text
sendIntentCount=1
acceptedSendAttemptCount=1
realGmailSendCount=1
duplicateProviderSendCount=0
```

### Checkpoint 9: Sent Sync, Restart, Isolation, And Human UAT

Goal: prove the completed product path survives normal use.

Actions:

- establish or resume the Gmail History cursor after the accepted send;
- synchronize the sent message into the selected project's Mail Center;
- verify message and thread identities are stable and project-scoped;
- rebuild and restart API, Worker, and frontend;
- verify generation history, generation 2, Opportunity, approved Draft,
  delivery state, message, and sync state survive;
- switch between at least two projects and verify no cross-project state;
- run desktop and mobile browser verification;
- have the user complete the full manual audit from project creation through
  the sent Mail Center item.

### Checkpoint 10: Real Reply Observation

This checkpoint is asynchronous and must not wait indefinitely.

```text
observationWindow=BOUNDED_AND_RECORDED
noReplyOutcome=PASS_WITH_EXTERNAL_ACTION
replyOutcome=VERIFY_INGESTION_THREADING_DEDUPE_RESTART
```

No reply within the observation window is not a fabricated product failure.
Record `RECIPIENT_REPLY_PENDING` and stop. If a reply arrives, prove one
project-scoped inbound message, correct thread association, no duplicates, and
restart persistence.

## 7. Verification Matrix

| Area | Focused proof | Real runtime proof | Human proof |
|---|---|---|---|
| Fresh project | project input and isolation tests | frontend creation and persisted versions | project details are correct |
| Blueprint | schema and generic-context tests | project-derived immutable Blueprint | generated targeting matches the site |
| Generation 1 | 0/1/9/10/11, restart, stale work | exactly 10 unique published domains | pool quality review |
| Resource Library | authority and project-filter tests | no global catalog in ordinary UI | only usable project results are visible |
| Opportunity | idempotency and no-refill tests | one Opportunity, pool remains 10 | selected target is appropriate |
| Archive/generation 2 | zero-side-effect archive and dedupe tests | archive then exact 10 new domains | controls and history are understandable |
| AI Draft | schema, semantic, evidence tests | real model run and immutable versions | exact version approved |
| Gmail preflight | state and timeout tests | connected/send-ready/sync-ready truth | final confirmation screen is correct |
| Send | send-intent and provider dedupe tests | one accepted provider send | explicit confirmation |
| Mail sync | cursor, project scope, restart tests | sent message visible after restart | Mail Center audit |
| Reply | inbound dedupe and threading tests | real reply when available | reply visibility review |

## 8. Timebox And Drift Control

Expected active execution time, excluding user confirmation and recipient
reply:

```text
checkpoint0To1=30_TO_60_MINUTES
checkpoint2To3=60_TO_120_MINUTES
checkpoint4To5=45_TO_90_MINUTES
checkpoint6To7=30_TO_60_MINUTES
checkpoint8To9=15_TO_30_MINUTES_AFTER_CONFIRMATION
expectedTotal=3_TO_6_HOURS
```

If a checkpoint exceeds its upper range:

1. stop later checkpoints;
2. record the exact failing invariant, request/job/workflow identity, logs, and
   provider deltas;
3. identify one root cause and one smallest generic repair;
4. do not broaden into cleanup, redesign, or another task;
5. continue only from the failed checkpoint after its focused test passes.

This timebox is a drift-control rule, not permission to accept incomplete
behavior.

## 9. Dirty-Tree And Collision Control

Planning snapshot:

```text
branch=外链part
head=d796989207cd7dfdec4c0a3fdbc46f855bf0fff9
worktreeEntries=346
unmergedFiles=0
gitMergeConflictBlocker=false
semanticCollisionRisk=HIGH
```

The dirty tree does not prove frontend/backend desynchronization. Execution
must verify source fingerprint, API build identity, Worker build identity,
OpenAPI, generated client, runtime health, and provider capability separately.

High-collision ownership areas:

```text
recommendation Blueprint, refill, publication, generation commands and queries
recommendation migrations and provider-budget persistence
Gmail runtime, polling workflow, send intent and sync repositories
FastAPI Gateway and generated Backlinks contracts
Recommendation Pool, Draft, Gmail, and Mail Center frontend surfaces
local-product start, restart, status, and provider configuration scripts
```

Rules:

1. Do not reset, clean, checkout, revert, or overwrite inherited user work.
2. Do not use parallel coding agents on shared hotspots.
3. Inspect the existing diff before editing a hotspot.
4. Stabilize backend contracts before one generated-client refresh.
5. Treat applied migrations as append-only.
6. Keep DataForSEO, AI, Gmail Send, and Gmail Sync controls independent.
7. Use one serial checkpoint owner and one canonical result document.
8. Stop with a concrete blocker if inherited edits cannot be safely adopted.

## 10. Result Status Contract

The result artifact must use one exact status:

```text
PLANNED_NOT_STARTED
IN_PROGRESS
BLOCKED
READY_FOR_HUMAN_UAT
FINAL_GMAIL_SEND_CONFIRMATION_REQUIRED
PASS_WITH_EXTERNAL_ACTION
PASS
```

- `FINAL_GMAIL_SEND_CONFIRMATION_REQUIRED`: Checkpoints 0-7 pass and zero real
  sends occurred.
- `PASS_WITH_EXTERNAL_ACTION`: Checkpoints 0-9 pass, one real send and sent
  sync are verified, and only a real recipient reply remains external.
- `PASS`: Checkpoints 0-10 all pass, including one real reply being ingested,
  associated with the correct thread, deduplicated, and preserved after
  restart.
- Fewer than 10, one-generation-only evidence, template-only AI, Gmail
  `CONNECTED` without send/sync readiness, unregistered Gmail activity loops,
  quiesced business consumers, manual data repair, or missing human UAT is not
  a pass.

Evidence labels:

```text
IMPLEMENTED
TESTED
RUNTIME_VERIFIED
REAL_PROVIDER_VERIFIED
HUMAN_UAT_VERIFIED
INPUT_REQUIRED
BLOCKED
```

## 11. Required Result Artifact

`docs/execution/WEBSITE-PROJECT-V3-E2E-002-result.md` must contain:

- completed Start Card and acceptance input;
- inherited-change manifest and conflict audit;
- checkpoint status and timestamps;
- changed files mapped to the failed invariant they repair;
- focused and broad verification commands with exact counts;
- runtime source/build identity and consumer state;
- project Context, Settings, Blueprint, generation, Job, Workflow, and
  idempotency identities;
- generation 1 and generation 2 published domains;
- Resource Library contribution count without exposing global inventory;
- DataForSEO calls, cycles, actual/unknown cost, and cursor evidence;
- Opportunity, contact, model run, Draft, and approval evidence;
- Gmail connection, send readiness, sync readiness, preflight, intent,
  attempt, message, thread, and cursor evidence;
- explicit real send count and duplicate-send count;
- restart, project isolation, desktop/mobile, and human-UAT evidence;
- reply observation result;
- remaining external action, stop boundary, commit state, and push state.

## 12. Exact Stop Rules

1. Initial execution stops at Checkpoint 7 until the user explicitly confirms
   the exact real Gmail send.
2. After confirmation, execution may continue only through Checkpoints 8-10
   for this same task.
3. Do not start another numbered task.
4. Do not commit, push, deploy, or send additional emails.
5. Do not clear history or manually mutate state to make the run look clean.
6. A blocker must name the failed invariant and smallest next action; it must
   not be hidden behind `running`, `quiesced`, or a generic timeout.

## 13. Ready-To-Run Instruction

```text
Use C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md.
Execute only WEBSITE-PROJECT-V3-E2E-002 from
docs/execution/WEBSITE-PROJECT-V3-E2E-002-execution-manual.md.
First obtain one fresh public acceptance website from the user and record the
normalized project input. Preserve the dirty worktree. Run checkpoints
serially, update docs/execution/WEBSITE-PROJECT-V3-E2E-002-result.md after each
checkpoint, and stop at FINAL_GMAIL_SEND_CONFIRMATION_REQUIRED. Do not send
Gmail until the user gives a new explicit confirmation for the exact approved
Draft Version. Do not commit or push.
```
