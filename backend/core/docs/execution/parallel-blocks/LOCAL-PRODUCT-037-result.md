# LOCAL-PRODUCT-037 Result

## Task Start Card

- Task ID: `LOCAL-PRODUCT-037`
- Task name: 联系人收敛、统一 API 合同和前端自动完成体验
- Started at: `2026-08-11`
- Authoritative manual: `C:\Users\DELL\Documents\缝合\GrowthOS-本地真实外链产品033后推荐池稳定化与任意新项目闭环分步Coding指令-V2.1-2026-08-11.md`
- Mandatory execution skill: `C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md`
- Repository: `C:\Users\DELL\Documents\缝合\john3947-seo`
- Prerequisite evidence: `LOCAL-PRODUCT-036=TESTED`, `handoffReadyFor037=true`, `runtimeDeploymentPending=true`, migration head `0058`, Worker `quiesced`, `businessConsumersRunning=false`.
- Runtime caveat: the running Build predates the 035/036 source changes. Existing `build.matches=true` is not deployment evidence for 035/036/037.
- Allowed implementation scope:
  - existing contact-enrichment SafeFetch, evidence discovery, registered Browser fallback, public-email extraction/classification, and recovery contracts;
  - existing recommendation supply operation status/query/API contracts;
  - FastAPI/OpenAPI/generated client parity;
  - existing frontend recommendation polling, reconnect, project switching, read-only refresh, pause/resume, and duplicate-start guards;
  - focused unit/contract/fixture Playwright tests and this result artifact.
- Frozen scope:
  - no changes to migrations `0057` or `0058`;
  - no reimplementation of LOCAL-PRODUCT-035 reassessment or LOCAL-PRODUCT-036 supply architecture;
  - no normal Worker, FastAPI, frontend, or Browser Worker startup;
  - no normal runtime rebuild or deployment;
  - no new acceptance Website Project;
  - no full Gate;
  - no commit or push.
- Provider ceiling: DataForSEO `0 calls / 0 micros`; AI `0`; Gmail Send `0`; Gmail Sync `0`; Browser Provider `0`. Only controlled local webpage fixtures are permitted.
- Data ceiling: Canonical local business-data mutations `0`; Provider ledger growth `0`.
- Expected touched areas:
  - `backend/core/src/**` and focused Core tests;
  - `backend/api-gateway/**` and focused contract tests;
  - `frontend/src/**`, generated client/OpenAPI artifacts, and focused frontend tests;
  - fixture-only Playwright specifications and screenshots;
  - this result file.
- Checkpoints:
  - CP1: contact convergence and recoverable/terminal status matrix.
  - CP2: one unified operation status contract across Core, FastAPI/OpenAPI, generated client, and frontend.
  - CP3: automatic polling/reconnect/read-only refresh/same-operation resume and duplicate-start prevention.
  - CP4: focused verification, before/after zero-call and zero-mutation evidence, result closeout.
- Stop point: after recording `status`, `runtimeDeploymentPending`, and `handoffReadyFor038`, stop without starting LOCAL-PRODUCT-038 or restoring normal runtime.

## CP1 - Contact Convergence

037 keeps contact recovery inside the existing Contact Enrichment activity and
the existing recommendation supply operation. It does not add a second Job,
Workflow, queue, or provider path.

Implemented flow:

1. `SafeFetchAdapter` retrieves only publicly reachable pages.
2. Existing evidence-entry discovery identifies candidate contact pages.
3. The already registered Browser Worker port is the only browser fallback.
4. Existing parser, evidence, candidate classification, and publication
   services produce public-email evidence.
5. Contact recovery continues through the same recommendation operation and
   existing Contact Enrichment identities.

The Browser fallback does not bypass CAPTCHA, login requirements, robots
restrictions, access denial, or site policy. If Browser fallback is configured
but no registered Browser Worker is available, the activity records
`BROWSER_UNAVAILABLE` as recoverable instead of silently changing transport.

### Contact Status Matrix

| Observed outcome | Classification | Retry | Publishable |
|---|---|---:|---:|
| Eligible public email plus evidence | `PUBLIC_EMAIL_FOUND` | no | yes |
| HTTP `408/425/429/500/502/503/504` before max attempts | recoverable transport failure | yes | no |
| Registered Browser fallback temporarily unavailable | `BROWSER_UNAVAILABLE` | yes | no |
| CAPTCHA or bot challenge | `CAPTCHA_OR_BOT_CHALLENGE` | no | no |
| Login wall | `LOGIN_REQUIRED` | no | no |
| Robots exclusion before a page is visited | `ROBOTS_DISALLOWED` | no | no |
| Access denied | `ACCESS_DENIED` | no | no |
| Unsupported response content | `UNSUPPORTED_CONTENT` | no | no |
| Contact form without a public email | `CONTACT_FORM_ONLY` | no | no |
| No public email evidence | `NO_PUBLIC_EMAIL` | no | no |
| Transient failures exhausted at max attempts | `SITE_UNREACHABLE` | no | no |
| Candidate evidence exists but is not eligible | `MANUAL_REVIEW_REQUIRED` | no | no |

Recommendation publication remains gated by project fit v3 plus an eligible,
compliant public email, source URL, evidence snapshot, candidate identity,
collection timestamp, and contact rules version. 037 does not lower that gate.

## CP2 - Unified Status API

### Contract Versions

- Core operation contract:
  `backlinks.recommendation-operation.v1`
- Backlinks OpenAPI artifact:
  `backend/contracts/openapi/backlinks.v1.json`
- Merged platform OpenAPI artifact:
  `backend/contracts/openapi/platform.v1.json`
- Generated frontend client:
  `frontend/src/api/generated/backlinks.ts`
- Generated operation count:
  `72`

The same recommendation-inventory response now carries:

- `operationId`, `jobId`, and `runningBuildId`;
- `stage`, `terminal`, and `terminalState`;
- `target`, `raw`, `fit`, `contact`, `published`, and `unpublished`;
- current `tier`, `round`, and `window`;
- independent paid and resource cursors;
- next retry time, error code, recovery action, and
  `providerCallOccurred`;
- the existing refill Job, contact batch, inventory-policy, and timing
  projections needed for compatibility.

Each published recommendation now carries:

- project-match reasons, matched keywords, and matched markets;
- priority and risk;
- metrics plus a distinct `metricsSource`;
- relevant pages;
- public-email source URL, extraction method, and observation time;
- `candidateSource`;
- resource type and resource-library `free`/`paid` attribution.

Resource-library snapshots are labelled
`resource_library_snapshot`; they are not presented as newly purchased
DataForSEO metrics. Mixed evidence and historical snapshots are also labelled
separately.

The existing FastAPI route remains a transparent read-only GET forward for
recommendation inventory. No 037 FastAPI implementation fork was required; a
focused gateway test proves the unified payload is forwarded unchanged.

## CP3 - Frontend Automatic Completion

The recommendation workspace now:

- persists one `operationId` per Website Project and recommendation-context
  version;
- automatically reconnects to that operation after refresh, project switching,
  and frontend/backend restart;
- subscribes to cross-tab storage changes;
- uses a short cross-tab start lease plus the server operation identity to
  prevent repeated clicks or concurrent tabs from creating a second business
  operation;
- automatically polls while the operation is active, including
  `PAUSED_BUDGET` and `PAUSED_PROVIDER`;
- stops only for explicit true terminal states:
  `TARGET_REACHED`, `PROJECT_CONTEXT_REQUIRED`, or
  `SUPPLY_FLOOR_REACHED`;
- refreshes the recommendation list when the published count increases;
- presents paused operations as continuing the original task;
- keeps the manual refresh action as GET-only;
- combines paid discovery and resource-library recommendations in one list
  while preserving source, free/paid, match, metrics, risk, page, and email
  evidence labels.

No normal frontend server was started. Browser verification used only the
controlled local static fixture:

`frontend/test/fixtures/local-product-037-recommendations.html`

### Playwright Evidence

| Check | Result |
|---|---|
| Desktop `1440x1000` | passed; no overlap or clipped recommendation metadata |
| Mobile `390x844` | passed; cards, controls, source labels, and email evidence remain readable |
| Keyboard | Tab navigation reached `重新读取`; Enter performed one GET refresh |
| GET-only refresh | fixture GET count changed `6 -> 7`; Provider call count stayed `0` |
| Same-project reload | `operation-037-alpha-same-id` remained attached |
| Project isolation | project beta used `operation-037-beta-isolated`; alpha identity was not reused |
| Provider fixture count | remained `0` through refresh, project switch, and reload |

Screenshots:

- `frontend/output/playwright/local-product-037/desktop.png`
  - SHA-256:
    `3A7A49B3566059435FC1842DB1D8442DFFF8980C31EB16D64E61367C13C45296`
- `frontend/output/playwright/local-product-037/mobile-390.png`
  - SHA-256:
    `3A3218B9B95B7E1105DC1B656BDC19DA95C923691BDB799FBAE6A3F473331FD0`

These screenshots prove the controlled fixture interaction and responsive
presentation only. They are not deployment evidence for the real frontend.

## Modified Files

Core contact and API contract:

- `backend/core/src/modules/backlinks/domain/contacts/contact-convergence.ts`
- `backend/core/src/modules/backlinks/activities/contact-enrichment.activity.ts`
- `backend/core/src/modules/backlinks/application/queries/recommendations.query.ts`
- `backend/core/src/modules/backlinks/api/recommendations.route.ts`
- `backend/core/src/modules/backlinks/api/private-server.ts`
- `backend/core/scripts/check-backlinks-openapi.ts`

Core tests:

- `backend/core/test/unit/contact-convergence.test.ts`
- `backend/core/test/backlinks/api/recommendations-route.test.ts`

FastAPI focused verification:

- `backend/api/tests/test_backlinks_gateway.py`

OpenAPI and generated clients:

- `backend/contracts/openapi/backlinks.v1.json`
- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/api/generated/backlinks.ts`
- `frontend/src/api/generated/platform.ts`

Frontend:

- `frontend/src/features/outreach/recommendations/api.ts`
- `frontend/src/features/outreach/recommendations/recommendation-operation-session.ts`
- `frontend/src/features/outreach/recommendations/recommendation-refill-polling.ts`
- `frontend/src/features/outreach/recommendations/use-recommendation-refill.ts`
- `frontend/src/features/outreach/recommendations/recommendations-workspace.tsx`
- `frontend/src/features/outreach/recommendations/recommendation-operation-session.test.mjs`
- `frontend/src/features/outreach/recommendations/recommendation-refill-polling.test.mjs`
- `frontend/src/features/outreach/recommendations/recommendations-source.test.mjs`
- `frontend/test/fixtures/local-product-037-recommendations.html`

Evidence:

- `frontend/output/playwright/local-product-037/desktop.png`
- `frontend/output/playwright/local-product-037/mobile-390.png`
- `backend/core/docs/execution/parallel-blocks/LOCAL-PRODUCT-037-result.md`

Migration change: none. Migration head remains `0058`; migrations `0057` and
`0058` were not modified.

## CP4 - Focused Verification

No full Gate was run.

### Core

Command:

```powershell
npx vitest run test/unit/contact-convergence.test.ts test/backlinks/api/recommendations-route.test.ts test/unit/backlinks-openapi.test.ts test/backlinks/api/send-intent-route.test.ts test/unit/local-product-gmail-sync-runtime.test.ts test/backlinks/api/placement-links-route.test.ts
```

Result: `6` files passed, `45/45` tests passed.

Coverage includes the contact status matrix, unified recommendation contract,
OpenAPI generation, Gmail Send contract, Gmail Sync runtime contract, and Links
route regression.

Additional Core checks:

- `npm run typecheck`: passed.
- `npx tsx scripts/check-backlinks-openapi.ts`: passed,
  `71` Backlinks paths.
- Scoped `git diff --check`: passed; existing line-ending warnings were not
  normalized.

### FastAPI

Focused `pytest` selection for unified recommendation inventory, Gmail, and
Links:

- Result: `21/21` passed.
- The Python environment used Codex bundled Python plus temporary test-only
  dependencies outside the repository.

No FastAPI server was started.

### Frontend

Focused Node tests:

- recommendation operation persistence and cross-tab start lease;
- polling, pause, terminal-state, and reconnect behavior;
- recommendation source display and generated contracts;
- Gmail Send/Sync projection regression;
- Links contract and workspace regression.

Result: `21/21` passed.

Additional frontend checks:

- `npm run typecheck`: passed.
- `npm run check:backlinks-client`: passed,
  `72` generated operations.

## Canonical Before And After

The before values are the completed 036 snapshot. The after values come from
the final 037 PostgreSQL `READ ONLY` transaction.

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

Canonical local business-data mutations by `LOCAL-PRODUCT-037`: `0`.

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
- Controlled browser fixture Provider count: `0`.
- DataForSEO remained enabled with
  `absoluteBudgetMicros=1000000`,
  `DATAFORSEO_MAX_PAID_CALLS=250`, and `reservedMicros=0`.
- Gmail Send and Sync remained enabled and independently governed.

## Guarded Runtime Records

The final read-only PostgreSQL transaction confirmed:

- Recommendation Refill Job
  `36e44372-c101-485a-bcca-5ec9811bcdbd` remains `waiting_provider`, step
  `provider_request_authorizing`, progress `10`, retry count `0`, version `3`.
- Commercial Discovery Batch
  `fe1ef5f3-40ea-4711-b3fe-80bfe1158d5a` remains `running`, paid cost `0`,
  Provider fingerprint count `0`, and no finish timestamp.
- Project Analysis outbox
  `6bdd8799-a8ee-4983-909b-564edbf0bed0` remains `pending`, attempt count `0`,
  unclaimed, and unpublished.
- Pending Contact Enrichment outbox remains `38`.

Temporal has exactly one running Workflow, the pre-existing
`backlinksGmailPollingSyncV1Workflow`. Running Recommendation Refill Workflows:
`0`.

The Gmail Workflow remains open in Temporal, but the quiesced Worker is not
polling business tasks. Mail cursor counts and versions did not change.

## Final Runtime Evidence

Final status checked at `2026-08-11T16:37:37.7184672+08:00`:

- `status=maintenance_ready`
- `apiBuildId=local-product-2337ef16419c97c3e86628d1`
- `workerBuildId=local-product-2337ef16419c97c3e86628d1`
- `build.matches=true`
- `workerExecutionMode=quiesced`
- `businessConsumersRunning=false`
- PostgreSQL `18.4`: healthy
- Backlinks migration head: `0058`
- RLS: ready
- Temporal: healthy
- `namespaceReady=true`
- FastAPI: stopped
- frontend: stopped
- Browser Worker: stopped

The running Build predates the source changes from 035, 036, and 037.
`build.matches=true` proves only that the currently configured maintenance
artifact matches its own running API and quiesced Worker. It does not prove
that 035/036/037 are deployed.

## Frozen Contract For 038

038 must consume, not reimplement:

- the 035 historical v2-to-v3 reassessment and contact-evidence validity rules;
- the 036 single 20-site supply operation, project Blueprint, independent
  paid/resource cursors, dynamic windows, and real supply terminal states;
- the 037 contact convergence classifier and existing SafeFetch/evidence/
  registered-Browser/public-email path;
- `backlinks.recommendation-operation.v1`;
- generated client parity;
- same-operation frontend persistence, polling, reconnect, pause/resume, and
  duplicate-start guards;
- explicit recommendation source, metrics source, resource free/paid, fit,
  risk, relevant-page, and email-evidence presentation.

037 does not provide deployment or real-provider acceptance. Runtime deployment
and any authorized acceptance remain later-gate work.

## Final Result

- status: `TESTED`
- runtimeDeploymentPending: `true`
- handoffReadyFor038: `true`

Stop conditions honored:

- LOCAL-PRODUCT-038 was not started.
- No acceptance Website Project was created.
- Normal Worker was not restored.
- FastAPI, frontend, and Browser Worker were not started.
- No normal runtime was rebuilt or deployed.
- No commit or push was performed.
