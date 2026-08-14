# LOCAL-PRODUCT-036 Result

## Task Start Card

- Task ID: `LOCAL-PRODUCT-036`
- Task name: Unified DataForSEO and governed resource-library 20-site
  supply orchestration
- Authority:
  - `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
  - `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-035-result.md`
  - Current read-only Canonical PostgreSQL and Temporal state
- Result path:
  `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-036-result.md`
- Scope:
  - Execute manual checkpoints `CP1 -> CP4`.
  - Extend the existing project-specific Blueprint, six-tier refill model,
    Recommendation Refill Job/Workflow/Queue, 0057 resource library, and 0058
    independent cursors into one idempotent 20-published-site operation.
  - Use deterministic fixtures and fake Provider transports only.
  - Preserve all hard fit, public-contact, safety, suppression, and
    cross-source deduplication gates.
  - Expose only `TARGET_REACHED`, `PAUSED_BUDGET`, `PAUSED_PROVIDER`,
    `PROJECT_CONTEXT_REQUIRED`, and `SUPPLY_FLOOR_REACHED` as external supply
    outcomes.
- Frozen contracts:
  - Do not reimplement or modify the 035 v2-to-v3 reassessment.
  - Do not modify migrations `0057` or `0058`, historical v2 facts, or contact
    evidence validity/reuse rules.
  - Do not create a second operation, Job, Workflow, Task Queue, resource
    table, or resource importer.
- Initially allowed files:
  - Existing generic Blueprint, refill-cycle, discovery, inventory-refill,
    workflow orchestration, and related contracts under
    `backend/core/src/modules/backlinks/**`.
  - Focused fixture/unit/integration tests under `backend/core/test/**`.
  - `backend/core/package.json` only if a focused test command is required.
  - This result document.
- Provider ceiling:
  - DataForSEO: `0 calls / 0 micros`.
  - AI: `0 calls`.
  - Gmail Send: `0 calls`.
  - Gmail Sync: `0 calls`.
  - Browser Provider: `0 calls`.
  - Provider request, task, lease, cost, and ledger counts must not increase.
- Canonical ceiling:
  - Local Canonical business-data mutations: `0`.
  - Do not consume the current waiting Recommendation Refill Job, running
    Commercial Discovery Batch, pending Project Analysis outbox, or the 38
    pending Contact Enrichment outbox events.
- Runtime boundary:
  - Worker remains `quiesced`.
  - Do not start normal Worker, FastAPI, frontend, or Browser Worker.
  - The currently running Build predates 035/036 source changes.
  - `build.matches=true` is not deployment evidence for 035 or 036.
  - Final result must state `runtimeDeploymentPending=true`.
- Verification plan:
  - Three unrelated Website Project fixtures with strict input isolation.
  - One-published-to-20 automatic continuation.
  - Multiple windows, cross-tier advancement, dynamic sample sizing, and
    full-chain paid/resource deduplication.
  - Resource matching by project Blueprint, authority, risk, language,
    country, category, tags, and resource type without weakening publication
    gates.
  - Budget/provider pause with zero-cost resource continuation and exact paid
    cursor resumption.
  - Restart, refresh, and duplicate-request idempotency.
  - Honest `SUPPLY_FLOOR_REACHED` only after paid, resource, and contact work
    are all stationary.
  - Read-only Provider/Canonical before-and-after snapshots.
- Full gate: not authorized.
- Git policy: preserve the dirty worktree; no unrelated cleanup, no commit,
  no push.
- Stop point: write the exact result and stop after `LOCAL-PRODUCT-036`; do not
  start `LOCAL-PRODUCT-037` or deploy/rebuild the normal runtime.

## Final Result

- Status: `TESTED`
- `handoffReadyFor037=true`
- `runtimeDeploymentPending=true`
- Worker remained `quiesced`; `businessConsumersRunning=false`.
- The running API/Worker Build ID still is
  `local-product-2337ef16419c97c3e86628d1`. This is valid maintenance-runtime
  identity evidence only. It predates the 035/036 source changes and is not
  evidence that this implementation has been deployed.
- No normal Worker, FastAPI, frontend, or Browser Worker was started.
- No real Provider transport was invoked and no Canonical business data was
  modified.
- `LOCAL-PRODUCT-037` was not started. No commit or push was performed.

## CP1 - Project-Independent Blueprint

The existing commercial discovery Blueprint now reads only the selected
Website Project's current context:

- country and language;
- product, topics, audiences, and keywords;
- target pages;
- project competitors;
- the same project's historical feedback.

No global competitor input, cross-project Blueprint cache, or named-project
branch was added. AI Blueprint fallback records:

- `generationMode`;
- `modelVersion`;
- `fallbackReason`;
- `discoveryInputs`.

The adapter prompt carries the same project-scoped historical feedback. The
fallback remains deterministic and records why AI generation was unavailable
or rejected.

## CP2 - One 20-Site Operation

The implementation extends the existing Recommendation Refill Job, Workflow,
Task Queue, discovery batches, and inventory policy. It does not create a
parallel operation or queue.

- The publish target is one operation with `20` simultaneously published,
  project-fit, public-email-ready sites.
- Tiers `1..5` remain paid discovery tiers; tier `6` is the existing governed
  resource library.
- Every tier supports multiple rounds and windows.
- A tier advances only after two consecutive windows produce no new eligible
  domains.
- Later sample sizes are derived from observed
  `raw -> fit -> contact -> published` conversion and remaining target.
- The operation identity, Job ID, Workflow ID, tier, round, window, and
  idempotency key are stable across refresh, restart, and duplicate requests.
- Deduplication includes prior candidates, recommendations, prospects,
  placements, opportunities, and the current operation's paid/resource
  results.
- Hard publication gates remain unchanged: project fit, compliant public
  email with source evidence, safety, suppression, and canonical-domain
  uniqueness.

## CP3 - Governed Resource Continuation And Independent Cursors

When published supply remains below `20`, orchestration can automatically use
the existing 0057 resource library without requiring a separate resource-page
action.

- The existing resource baseline is read and rescored; it is not re-imported
  or rewritten.
- Resource matching uses the current project's Blueprint against categories,
  tags, language, country, resource type, authority, and risk.
- Authority is only one signal and cannot replace project fit.
- Paid/free is retained as evidence metadata and never triggers a purchase.
- Resource candidates still pass the same contact and publication gates.
- The 0058 paid tier/round cursor and resource tier/round cursor advance
  independently.
- During budget/provider pause, resource supply may continue while the paid
  cursor is retained.
- When paid Provider availability returns, planning resumes the same Job and
  exact paid cursor rather than creating another Job, Workflow, request, or
  paid call.

No migration was required. Migration head remains `0058`; migrations `0057`
and `0058` were not modified.

## CP4 - External Outcomes

The supply planner exposes only:

- `TARGET_REACHED`
- `PAUSED_BUDGET`
- `PAUSED_PROVIDER`
- `PROJECT_CONTEXT_REQUIRED`
- `SUPPLY_FLOOR_REACHED`

`SUPPLY_FLOOR_REACHED` is available only after paid windows, matching resource
items, and contact processing are all stationary. Partial real results and
funnel/elimination facts remain attached to the existing operation. A
budget/provider pause is recoverable and preserves the same operation and
paid cursor.

## Modified Files

Production implementation:

- `backend/core/src/modules/backlinks/adapters/ai/ai-sdk-commercial-discovery-blueprint.adapter.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-inventory-refill.service.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts`
- `backend/core/src/modules/backlinks/application/services/commercial-supply-operation.service.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.ts`
- `backend/core/src/modules/backlinks/domain/recommendations/commercial-refill-cycle.ts`
- `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts`
- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
- `backend/core/src/modules/backlinks/workflows/client.ts`
- `backend/core/src/modules/backlinks/workflows/namespaces.ts`
- `backend/core/src/modules/backlinks/workflows/definitions/index.ts`
- `backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.ts`
- `backend/core/src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.workflow.ts`

Directed verification:

- `backend/core/test/unit/commercial-discovery-blueprint.test.ts`
- `backend/core/test/unit/commercial-recommendation-discovery.service.test.ts`
- `backend/core/test/unit/commercial-refill-cycle.test.ts`
- `backend/core/test/unit/commercial-inventory-refill.test.ts`
- `backend/core/test/unit/commercial-supply-fixtures.test.ts`
- `backend/core/test/backlinks/integration/recommendation-refill-workflow.test.ts`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-036-result.md`

## Three-Project Funnel Evidence

All figures below are deterministic fixture facts. The projects have unrelated
products, topics, audiences, keywords, target pages, countries, languages,
competitors, and historical feedback.

| Project fixture | Initial raw/fit/contact/published | Final raw | Final fit | Final contact | Final published | Fixture calls |
|---|---:|---:|---:|---:|---:|---:|
| Solar installer CRM | `3/1/1/1` | 35 | 22 | 20 | 20 | 3 |
| Pet nutrition education | `5/2/2/2` | 46 | 25 | 22 | 20 | 3 |
| Accounting workflow SaaS | `0/0/0/0` | 68 | 33 | 23 | 20 | 4 |

Each fixture reached `20` using only its own Blueprint. Domains and matching
terms from either of the other fixtures were rejected rather than leaking
across projects.

## Tier And Window Fixture Calls

| Scenario | Tier/round/window | raw/fit/contact/published | Calls |
|---|---|---:|---:|
| Solar CRM | `t1/r1/w1` | `12/7/6/6` | 1 |
| Solar CRM | `t1/r1/w2` | `10/6/6/6` | 1 |
| Solar CRM | `t1/r1/w3` | `10/8/7/7` | 1 |
| Pet nutrition | `t1/r1/w1` | `15/8/6/5` | 1 |
| Pet nutrition | `t1/r1/w2` | `14/8/7/6` | 1 |
| Pet nutrition | `t1/r1/w3` | `12/7/7/7` | 1 |
| Accounting SaaS | `t1/r1/w1` | `20/8/5/4` | 1 |
| Accounting SaaS | `t1/r1/w2` | `18/9/6/5` | 1 |
| Accounting SaaS | `t1/r1/w3` | `16/8/6/5` | 1 |
| Accounting SaaS | `t1/r1/w4` | `14/8/6/6` | 1 |
| One-to-20 continuation | `t1/r3/w1` | `10/0/0/0` | 1 |
| One-to-20 continuation | `t1/r3/w2` | `10/0/0/0` | 1 |
| One-to-20 continuation | `t2/r3/w1` | `30/12/8/7` | 1 |
| One-to-20 continuation | `t2/r3/w2` | `24/10/7/6` | 1 |
| One-to-20 continuation | `t2/r3/w3` | `20/8/6/6` | 1 |

The one-to-20 fixture began with one published site. Two empty tier-1 windows
caused exactly one tier transition. The tier-2 requested sample then reduced
from `30` to `24` to `20` as observed conversion and remaining demand changed.
It stopped at exactly `20` published sites.

## Cursor And Idempotency Evidence

- Budget-pause fixture started with paid cursor `tier=4, round=5` and resource
  cursor `tier=6, round=9`.
- While paid discovery was paused, the next plan was resource
  `tier=6, round=9, window=1`; paid remained `tier=4, round=5`.
- After Provider availability returned, the next paid plan resumed
  `tier=4, round=5, window=1`.
- An aged provider-unavailable batch retried the same paid identity
  `tier=2, round=4, window=2`.
- A recent provider-unavailable batch returned `PAUSED_PROVIDER` without
  creating another request.
- Repeating the same planner input returns the same operation, window, and
  idempotency key. Duplicate planning added `0` fixture transport calls.
- The one-to-20 fixture had exactly `5` unique call keys for `5` executed
  windows. Refresh/replan assertions did not increase that count.

## Resource And Hard-Gate Evidence

- Solar, pet-nutrition, and accounting resource fixtures were ranked only for
  their corresponding project.
- An unrelated high-authority resource failed project fit.
- A relevant but unsafe/high-risk resource failed the hard gate.
- Paid/free resource metadata was preserved without a purchase action.
- Resource-tier execution did not authorize a paid budget, invoke a paid
  Provider transport, or call AI.
- The test's project-page evidence fetch used an in-memory fixture; no Browser
  Provider process or real network transport was used.
- Full-chain duplicate domains were excluded before publication.
- Exhaustion returned `SUPPLY_FLOOR_REACHED` only after both paid and resource
  supply were exhausted and contact work was stationary.

## Directed Test Results

- CP1-CP4 fixture/workflow suite: `6` files, `34` tests, passed.
- Temporal workflow bundle: compiled successfully.
- 035 frozen-contract regression suite: `6` files, `19` tests, passed.
- Core TypeScript typecheck: passed.
- Directed ESLint for implementation and tests: passed.
- Backlinks migration manifest: `51` files through `0058`, passed.
- Source manifest: `28` records, passed.
- `git diff --check`: passed. Existing line-ending warnings were not
  normalized.

## Canonical Before And After

The before values are the exact completed 035 snapshot. The after values are
from the final 036 read-only transaction.

| Canonical fact | Before | After |
|---|---:|---:|
| Commercial candidates v2 | 236 | 236 |
| Commercial candidates v3 | 839 | 839 |
| Recommendation scores v2 | 139 | 139 |
| Recommendation scores v3 | 158 | 158 |
| Recommendation inventory total | 200 | 200 |
| Published inventory | 25 | 25 |
| Contact Enrichment Jobs | 197 | 197 |
| Contact Enrichment outbox events | 391 | 391 |
| Pending Contact Enrichment outbox | 38 | 38 |
| Recommendation Refill Jobs | 67 | 67 |
| Commercial Discovery Batches | 19 | 19 |
| Recommendation Refill outbox events | 67 | 67 |
| Project Analysis outbox events | 9 | 9 |
| Pending Project Analysis outbox | 1 | 1 |
| Historical BUDGET policies | 0 | 0 |
| Historical PROVIDER_UNAVAILABLE policies | 3 | 3 |
| Historical TIERS_EXHAUSTED policies | 2 | 2 |

Canonical local business-data mutations by `LOCAL-PRODUCT-036`: `0`.

## Provider And Gmail Zero-Call Evidence

| Safety fact | Before | After |
|---|---:|---:|
| Legacy Provider requests | 177 | 177 |
| Active legacy requests | 0 | 0 |
| Provider batch requests | 91 | 91 |
| Active Provider batch requests | 0 | 0 |
| Active Provider task IDs | 0 | 0 |
| Active Provider actual cost micros | 0 | 0 |
| Provider leases | 52 | 52 |
| Active Provider leases | 0 | 0 |
| Provider ledger entries | 174 | 174 |
| Reserved ledger entries | 0 | 0 |
| Ledger actual cost micros | 3,030,768 | 3,030,768 |
| DataForSEO spent micros | 950,976 | 950,976 |
| DataForSEO remaining micros | 49,024 | 49,024 |
| Gmail send-attempt rows | 2 | 2 |
| Mail-sync cursors | 1 | 1 |
| Mail-sync cursor version sum | 11 | 11 |
| Gmail-connection sync cursors | 0 | 0 |

- DataForSEO: `0 real calls / 0 micros`.
- AI: `0 real calls`.
- Gmail Send: `0 calls`.
- Gmail Sync: `0 calls`.
- Browser Provider: `0 calls`.
- DataForSEO remained enabled with
  `absoluteBudgetMicros=1000000`, `maxPaidCalls=250`, and
  `reservedMicros=0`.
- Gmail Send and Sync remained enabled and independently governed.

## Guarded Runtime Records

The final read-only transaction confirmed:

- Recommendation Refill Job
  `36e44372-c101-485a-bcca-5ec9811bcdbd` remains `waiting_provider`, step
  `provider_request_authorizing`, progress `10`, retry count `0`, version `3`.
- Commercial Discovery Batch
  `fe1ef5f3-40ea-4711-b3fe-80bfe1158d5a` remains `running`, with `0`
  Provider fingerprints, `0` paid cost, and no finish timestamp.
- Project Analysis outbox
  `6bdd8799-a8ee-4983-909b-564edbf0bed0` remains `pending`, attempt count `0`,
  unclaimed, unpublished, aggregate version `1`.
- Temporal has exactly `1` running Workflow: the pre-existing
  `backlinksGmailPollingSyncV1Workflow`.
- Running Recommendation Refill Workflows: `0`.

No waiting Job, running Batch, Project Analysis outbox, or pending Contact
Enrichment outbox event was consumed or edited.

## Final Runtime Evidence

Status checked on `2026-08-11T15:31:45+08:00`:

- `status=maintenance_ready`
- `apiBuildId=local-product-2337ef16419c97c3e86628d1`
- `workerBuildId=local-product-2337ef16419c97c3e86628d1`
- `build.matches=true`
- `workerExecutionMode=quiesced`
- `businessConsumersRunning=false`
- PostgreSQL `18.4`: healthy; Backlinks migration head `0058`; RLS ready.
- Temporal: healthy; `namespaceReady=true`.
- FastAPI, frontend, and Browser Worker: stopped.

Again, `build.matches=true` applies to the pre-035/036 maintenance build. The
036 implementation was deliberately not rebuilt or deployed.

## Frozen 035 Contract

036 consumes but does not reimplement or overwrite:

- immutable v2-to-v3 historical candidate and score reassessment;
- public-contact evidence validity, reuse, and expiry;
- Contact Enrichment Job/outbox identity for missing or expired evidence;
- 0058 paid/resource cursor schema and historical backfill;
- historical BUDGET, PROVIDER_UNAVAILABLE, and TIERS_EXHAUSTED reconciliation;
- the guarded dry-run/apply/second-dry reassessment entrypoint.

Migrations `0057` and `0058`, all historical v2 facts, and the 035 result
artifact were left unchanged.

## Exact Stop State

```text
status=TESTED
handoffReadyFor037=true
runtimeDeploymentPending=true
workerExecutionMode=quiesced
businessConsumersRunning=false
canonicalBusinessDataMutations=0
dataForSeoRealCalls=0
dataForSeoActualCostMicrosDelta=0
aiRealCalls=0
gmailSendCalls=0
gmailSyncCalls=0
browserProviderCalls=0
providerLedgerDelta=0
runningRecommendationRefillWorkflows=0
localProduct037Started=false
normalWorkerRestored=false
fastApiStarted=false
frontendStarted=false
browserWorkerStarted=false
commitCreated=false
pushPerformed=false
```
