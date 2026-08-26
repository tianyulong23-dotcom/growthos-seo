# BACKLINKS-POST-RECOMMENDATION-VALUE-CHAIN-E2E-001

Date: 2026-08-22

Overall status: INPUT_REQUIRED

This document records one P0-P8 implementation task. A checkpoint may be
IMPLEMENTED or TESTED, but the task must not be marked COMPLETE without the
real full-chain UAT required by the architecture plan.

## Execution Boundary

- Provider ceiling: DataForSEO 0, Gmail send/sync 0, AI 0, Direct Monitor 0.
- No worker unlock, refill, Provider request, lease, ledger, migration apply,
  commit, push, merge, or deployment is authorized.
- The existing checkout contains broad historical changes. They are preserved
  and are not attributed to this task.
- Recommendation generation, query, command, admission, scoring, publication,
  inventory, contact discovery, Recommendation UI, and their business semantics
  are frozen.

## P0 Recommendation Handoff Freeze

Status: TESTED

### Repository Baseline

- Branch: `main`
- HEAD: `2092d0da79cf8b126421369a9ca9db7fd4acd503`
- Working-tree entries at freeze: 369
- Modified tracked files at freeze: 229
- Untracked files at freeze: 163
- Platform Alembic source head: `20260815_0065`
- Platform database Alembic head: `20260815_0065`
- Backlinks migration source/manifest head: `0073`
- Backlinks migration check: 66 files valid through `0073`

### Frozen Source Fingerprint

The selector is deterministic:

1. Run `rg --files` over both
   `backend/core/src/modules/backlinks/` and
   `frontend/src/features/outreach/recommendations/`.
2. Apply the same case-insensitive path marker to both trees:
   `recommend|commercial-(candidate|discovery|qualification|inventory|refill|score|supply)|contact-enrichment|cooperation-path`.
3. Include these composition and Provider-governance files:
   - `backend/core/src/index.ts`
   - `backend/core/src/modules/backlinks/api/private-server.ts`
   - `backend/core/src/modules/backlinks/application/policies/dataforseo-call.policy.ts`
   - `backend/core/src/modules/backlinks/db/repositories/provider-budget.repository.ts`
   - `backend/core/src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.ts`
   - `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.ts`
   - `backend/core/src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts`
   - `backend/core/src/modules/backlinks/runtime/local-product-ai-bootstrap.ts`
   - `backend/core/src/modules/backlinks/runtime/local-product-ai-runtime.ts`
   - `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
   - `backend/core/src/modules/backlinks/workflows/worker.ts`
   - `backend/core/src/modules/backlinks/workflows/outbox-relay.ts`
4. Preserve the original P0 PowerShell ordering: sort the raw Windows `rg`
   paths together with the explicit POSIX paths, normalize separators while
   building entries, hash each file with SHA-256, serialize each entry as
   `path + NUL + file_hash`, join entries with LF, and SHA-256 the resulting
   UTF-8 payload.

- Frozen file count: 94
- Frozen normalized ordered path-list SHA-256:
  `06c6b93f65816e7fd011e5df869a2ec264d4324c6d018f700fc3ceef244edf5d`
- Frozen snapshot SHA-256:
  `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689`

The automated guard also freezes the exact 94-path set and reports missing
and unexpected relative paths on mismatch. The original PowerShell command
and the shared-contract test independently reproduced all three values above.

### Recommendation Contract Baseline

The semantic selector starts from every Backlinks OpenAPI path whose path
contains `recommendation`. It includes each complete path item and operation,
then recursively follows every reachable local `#/components/*` reference.
This covers schemas and any reachable parameters, request bodies, responses,
security schemes, headers, examples, callbacks, or links without relying on a
component naming convention. The resulting `{paths, components}` object is
serialized as compact JSON with recursively sorted keys and hashed with
SHA-256.

- Backlinks OpenAPI raw SHA-256:
  `389ca08bc06f9baf783492f89f86aff101131b0d2ca9a290089244728b5fe88f`
- Recommendation root paths: 9
- Recommendation root operations: 9
- Reachable components before official regeneration: 0
- Reachable component counts by section: none
- Recommendation semantic closure SHA-256 before official regeneration:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`
- Reachable components after official regeneration: 0
- Reachable component counts by section after official regeneration: none
- Recommendation semantic closure SHA-256 after official regeneration:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`
- Backlinks OpenAPI raw SHA-256 after official regeneration:
  `389ca08bc06f9baf783492f89f86aff101131b0d2ca9a290089244728b5fe88f`
- Generated Backlinks client: valid, 80 operations

The current Backlinks OpenAPI generator inlines the request and response
schemas for these operations, so the reachable component count is zero. The
collector is recursive and section-agnostic; a future `$ref` will be resolved
and included in the same fingerprint instead of being silently omitted.

The shared aggregate contract now contains 239 paths and 269 operations, with
52 Platform operations. The contract test also requires these exact P1
additions instead of accepting aggregate count drift alone:

- `GET /api/v1/projects/{project_id}/outreach-readiness`
  - operationId:
    `get_project_outreach_readiness_api_v1_projects__project_id__outreach_readiness_get`
- `POST /api/v1/projects/{project_id}/promotion-target`
  - operationId:
    `publish_project_promotion_target_api_v1_projects__project_id__promotion_target_post`

Post-generation focused contract result: 6 passed. Recommendation source
fingerprint, raw OpenAPI hash, recursive semantic closure, and generated client
validation all remained unchanged.

### Tenant-Scoped Data Baseline

Evidence was read inside a rolled-back transaction using
`growthos_backlinks_writer` and the exact organization, workspace, and Website
Project context. Counts below are project scoped, not global.

- Website Project: `68299b17-33d6-4993-b106-cf24f1f880bc`
- Recommendations: 11
- Recommendation inventory rows: 11
- Maximum visible pool generation: 1
- Recommendation refills: 34
- Provider requests: 65 (`succeeded` 53, `failed` 12)
- Provider ledger rows: 53 (`settled` 53)
- Provider ledger actual cost: 897348 micros, historical baseline only
- Active Provider fetch leases: 0
- `unknown_charge`: 0

No Provider call or cost was created by this checkpoint.

## P1 Project Outreach Readiness

Status: TESTED

### Schema Ownership Correction

- The current Site Profile fact table is `platform.site_profiles`.
- Its key is `project_id`; it does not expose an `id` column.
- The immutable Website Profile version table is
  `platform.website_profile_versions`.
- `platform.projects.current_profile_version_id` references the immutable
  Website Profile version.
- The readiness query joins
  `site_profile.project_id = project.id` and
  `profile.id = project.current_profile_version_id`.
- A previous diagnostic query against `crawling.site_profiles`, and a later
  assumption about `site_profile.id`, were evidence-query errors. They are not
  treated as product defects.

Model, migration, repository, live-schema, and focused regression evidence now
agree on this ownership contract. Focused readiness tests: 6 passed.

### Task-Owned Files

New files owned entirely by this task:

- `backend/api/app/modules/projects/readiness.py`
- `backend/api/tests/test_project_outreach_readiness.py`
- `frontend/src/features/projects/project-outreach-readiness.tsx`
- `frontend/src/features/projects/project-outreach-readiness.test.tsx`
- `backend/core/docs/execution/BACKLINKS-POST-RECOMMENDATION-VALUE-CHAIN-E2E-001-result.md`

Symbol-level additions in historically modified shared files:

- `backend/api/app/api/routes/projects.py`
  - readiness dependency and GET route
  - explicit promotion-target publish route
- `backend/api/app/modules/projects/schemas.py`
  - readiness response contract
- `backend/api/app/modules/projects/service.py`
  - public promotion-target publish delegate to the existing repository path
- `frontend/src/api/projects.ts`
  - readiness read adapter and explicit publish adapter
- `frontend/src/features/projects/types.ts`
  - readiness and promotion-target types
- `frontend/src/pages/module-page.tsx`
  - Project settings readiness mount
- `backend/api/tests/test_shared_contracts.py`
  - exact P1 route/method/operationId assertions
  - recursive Recommendation OpenAPI semantic-closure guard
  - deterministic Recommendation source fingerprint guard

Generated or contract files may only be updated by their official generators:

- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/api/generated/backlinks.ts`

No Recommendation frozen source or frontend file is task-owned.

### Read-Only Runtime Acceptance

The local API replay ran with application lifespan disabled, background
dispatch disabled, and Backlinks project projection disabled. No write action
was invoked from the API or UI.

For Website Project `68299b17-33d6-4993-b106-cf24f1f880bc`, the readiness GET
returned the current product truth:

- Status: `STALE`
- Site Profile version:
  `a72a42ed-6396-47ad-aa86-760900ee127c`
- Outreach Profile version:
  `a72a42ed-6396-47ad-aa86-760900ee127c`
- Promotion Target version:
  `51c3c8c5-76a1-4461-b973-7825afad484a`
- Fingerprint:
  `sha256:d0828f4ec7e749f77cb6f1c82c851454934bb6e468d982949c5d4528a8c1b87d`
- Input required: `WEBSITE_PROJECT:republish_promotion_target`
- Primary recovery action: `REPUBLISH_PROMOTION_TARGET`

Repeated GET responses were byte-identical. A request using unrelated project
ID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` returned 404, and the subsequent
request for the real project remained byte-identical to the first response.

The Project settings UI was exercised through a temporary Vite proxy connected
to the checkpoint API. A browser refresh rendered the same `STALE` status,
version IDs, fingerprint, missing-evidence explanation, and recovery action.
The readiness request completed with 200. The existing Agent conversations
route returned unrelated 404 responses and did not affect the readiness view.

Visual evidence:
`output/playwright/p1-project-outreach-readiness.png`.

This database currently contains only one active Website Project for the
tenant. A real two-project browser switch could therefore not be performed
without manufacturing project data. Cross-project API isolation was verified
with the 404 replay above, and the frontend focused test verifies that a late
response from a previously selected project is never displayed.

### Side-Effect Equality

The pre- and post-replay snapshots were both read inside rolled-back
transactions using `growthos_backlinks_writer` and the exact Core-equivalent
organization, workspace, Website Project, and project context. Every query also
included exact tenant and project predicates.

The snapshots were identical:

```json
{
  "active_leases": 0,
  "inventory": 11,
  "ledger_actual_cost_micros": 897348,
  "ledger_rows": 53,
  "ledger_settled": 53,
  "max_generation": 1,
  "provider_batch_requests": 65,
  "provider_requests": 65,
  "provider_requests_failed": 12,
  "provider_requests_succeeded": 53,
  "recommendations": 11,
  "refills": 34,
  "unknown_charge": 0
}
```

The ledger amount is historical baseline data. This task created no refill,
Provider request, lease, ledger row, unknown charge, Recommendation, inventory
row, or generation.

### Checkpoint Report

- Owned changes: listed above.
- Focused tests: backend readiness 6 passed; shared contract/freeze 6 passed;
  frontend readiness 2 passed; Ruff passed; generated Backlinks client check
  passed with 80 operations.
- Runtime acceptance: repeated readiness GET, browser refresh, project-isolation
  replay, and tenant/RLS pre/post equality passed.
- Explicit publish behavior: route/delegate contract and separation from GET
  passed focused tests. No live publish was performed because this checkpoint
  is constrained to zero side effects.
- Frozen Recommendation semantic diff: zero after official OpenAPI/client
  generation.
- Provider calls/cost: 0 calls, USD 0 for this task.
- Downstream handoff: P1 evidence was consumed by P2 without changing the
  frozen Recommendation surface.
- Completion boundary: the P0-P8 task remains `IN PROGRESS`; no full-chain UAT,
  deployment, real Provider run, or live publish transition is claimed.

## P2 Recommendation Selection To Opportunity

Status: TESTED

### Implemented Contract

- Opportunity list and detail now expose one backend-derived
  `engagementPathState`:
  - `EMAIL_READY` only when the selected channel is email, a reviewed contact
    email exists, and contact review is not pending.
  - `MANUAL_PATH_READY` only when a cooperation path has an explicit manual
    action state.
  - `CONTACT_PENDING` for every incomplete contact/path handoff.
- Each state exposes one backend-derived `primaryNextAction`. A
  `CONTACT_PENDING` Opportunity is explicitly disabled for email drafting and
  sending.
- Opportunity detail exposes a selection snapshot using existing immutable
  facts and lifecycle evidence: Recommendation/context, visible generation,
  generation contract, input pin, model/context/profile/target versions,
  immutable fingerprint, selected target/contact/path, actor, and timestamp.
- The versioned Opportunity command accepts a Recommendation only from the
  current latest policy context and visible generation. Projects with no policy
  history retain the existing legacy behavior.
- The existing Opportunity lifecycle/audit JSON stores the selection snapshot.
  No table, migration, or second source of truth was added.
- The Opportunity UI consumes the backend state, shows the handoff summary,
  blocks draft entry for `CONTACT_PENDING`, and provides stable links back to
  the selected Recommendation or the applicable email/manual workflow.

### Task-Owned Files

New files owned entirely by this task:

- `backend/core/src/modules/backlinks/application/read-models/opportunity-handoff.ts`
- `backend/core/test/unit/opportunity-handoff.test.ts`
- `backend/core/test/unit/opportunity-selection-contract.test.ts`

Symbol-level changes in historically modified shared files:

- `backend/core/src/modules/backlinks/application/queries/opportunities.query.ts`
  - derived handoff state/action and immutable selection snapshot
- `backend/core/src/modules/backlinks/api/opportunities.route.ts`
  - public response schemas for the new read-model fields
- `backend/core/src/modules/backlinks/db/repositories/opportunity.repository.ts`
  - current context/generation selection guard and lifecycle snapshot
- `backend/core/test/backlinks/api/opportunities-route.test.ts`
  - route/read-model regression coverage
- `frontend/src/features/outreach/opportunities/opportunities-workspace.tsx`
  - handoff summary, gating, and stable deep links
- `frontend/src/features/outreach/opportunities/opportunities-source.test.mjs`
  - source-level state and navigation regressions

Official generated artifacts:

- `backend/contracts/openapi/backlinks.v1.json`
- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/api/generated/backlinks.ts`

No Recommendation generation, query, command, policy, score, publication,
inventory, contact-discovery, Recommendation UI, or other frozen source is
task-owned.

### Checkpoint Report

- Focused Core tests: 3 files, 6 tests passed.
- Frontend Opportunity source tests: 4 passed.
- Core typecheck: passed.
- Frontend typecheck: passed.
- Backlinks OpenAPI check: passed with 79 paths.
- Shared aggregate generation and contract/freeze tests: 12 passed, 239 paths,
  269 operations.
- Generated Backlinks client: valid with 80 operations.
- P0 source fingerprint: 94 files and
  `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689`.
- Frozen Recommendation semantic closure:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`;
  semantic diff zero.
- Full Backlinks OpenAPI SHA-256 after the permitted Opportunity contract
  addition:
  `882cda4d44a40fc74d6c867dc8479276a51b284928c5aefb914fb058dfbc07e1`.
  This aggregate change is outside the frozen Recommendation paths.
- Provider calls/cost: DataForSEO 0, Gmail 0, AI 0, Direct Monitor 0, USD 0.
- Database/migration/deployment effects: none. No DB-backed mutation or runtime
  replay was performed at this checkpoint.
- Downstream handoff: P2 read models and snapshot contract are available for
  P3 action-queue and draft-freshness work.
- Remaining acceptance gap: tenant/RLS concurrency, stale-context command, and
  project-switch behavior are covered by pure/query/UI contracts only in this
  zero-write run. They are not claimed as real runtime UAT.

## P3 Opportunity To Draft

Status: TESTED

### Implemented Contract

- Draft reads now expose an immutable input snapshot covering Opportunity
  evidence, request/context versions, selected contact version, and the
  generated draft version.
- Draft freshness is derived as `FRESH`, `STALE`, or `UNKNOWN`, with explicit
  stale reasons for project context, Opportunity, and contact changes.
- Manual subject/body edits remain user-owned draft versions. A stale generated
  draft is never silently regenerated or overwritten.
- Approval, send preflight, and Send Intent creation are disabled unless the
  selected draft version is `FRESH`.
- Opportunity list/detail exposes one backend-derived action queue spanning
  draft creation, draft wait/edit/review, send-readiness review, mail status,
  manual cooperation, and unresolved contact/path work.
- The Draft UI renders the immutable input snapshot and stale evidence, keeps
  manual editing available, and routes the operator to the exact recovery
  action without mutating Recommendation state.

### Task-Owned Files

New files owned entirely by this task:

- `backend/core/src/modules/backlinks/application/read-models/draft-freshness.ts`
- `backend/core/test/unit/draft-freshness.test.ts`

Symbol-level changes in historically modified shared files:

- `backend/core/src/modules/backlinks/application/read-models/opportunity-handoff.ts`
  - draft-aware action queue derivation
- `backend/core/src/modules/backlinks/application/queries/opportunities.query.ts`
  - draft state inputs for the handoff projection
- `backend/core/src/modules/backlinks/api/opportunities.route.ts`
  - action-queue response contract
- `backend/core/src/modules/backlinks/application/repositories/draft-generation.repository.ts`
  - immutable generation input snapshot persistence/read mapping
- `backend/core/src/modules/backlinks/application/queries/draft.query.ts`
  - draft input snapshot and freshness projection
- `backend/core/src/modules/backlinks/api/draft.route.ts`
  - public snapshot/freshness response schemas
- `backend/core/test/unit/opportunity-handoff.test.ts`
  - draft action-queue regressions
- `backend/core/test/backlinks/api/draft-editing-route.test.ts`
  - snapshot/freshness route regressions
- `frontend/src/features/outreach/drafts/draft-page.tsx`
  - snapshot display, stale recovery, and approval/send gating
- `frontend/src/features/outreach/drafts/draft-read-contract.test.mjs`
  - draft read/gating source regressions
- `frontend/src/features/outreach/opportunities/opportunities-workspace.tsx`
  - backend action-queue rendering
- `frontend/src/features/outreach/opportunities/opportunities-source.test.mjs`
  - queue and navigation regressions

Official generated artifacts:

- `backend/contracts/openapi/backlinks.v1.json`
- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/api/generated/backlinks.ts`

No Recommendation generation, query, command, policy, score, publication,
inventory, contact-discovery, Recommendation UI, or other frozen source is
task-owned.

### Checkpoint Report

- Focused Core tests: 4 files, 14 tests passed.
- Frontend Draft/Opportunity source tests: 5 passed.
- Core typecheck: passed.
- Frontend typecheck: passed.
- Backlinks OpenAPI check: passed with 79 paths.
- Shared contract/freeze tests: 6 passed, 239 paths, 269 operations.
- Generated Backlinks client: valid with 80 operations.
- P0 source fingerprint: 94 files and
  `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689`.
- Frozen Recommendation semantic closure:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`;
  semantic diff zero.
- Full Backlinks OpenAPI SHA-256 after the permitted Draft/Opportunity contract
  addition:
  `ee4a47ba36682edb77f9ba3c3288cb91173cfa9a175a05b9ae403b2a8f2f7fab`.
  This aggregate change is outside the frozen Recommendation paths.
- Provider calls/cost: DataForSEO 0, Gmail 0, AI 0, Direct Monitor 0, USD 0.
- Database/migration/deployment effects: none. No DB-backed mutation or runtime
  replay was performed at this checkpoint.
- Downstream handoff: P3 freshness and action-queue contracts are available for
  the P4 Gmail send/reconciliation workbench.
- Remaining acceptance gap: stale-draft regeneration, approval, and send
  blocking are verified by pure/query/UI contracts only. No real Gmail account,
  human send confirmation, Provider dispatch, or reply UAT is claimed.

## P4 Gmail Readiness, Send And Reply Workbench

Status: BLOCKED

### Implemented And Tested Without Frozen Wiring

- The Send Intent read model now exposes an immutable delivery envelope and
  derived queue state for `PENDING_SEND`, `RECONCILIATION_REQUIRED`, and
  `WAITING_REPLY`.
- A tenant/project-scoped keyset list query and its response schemas are
  implemented outside the frozen Recommendation region.
- The collection route is exported independently as
  `registerBacklinksSendIntentListRoute`, but is deliberately not registered in
  the production server because the required runtime forwarding and server
  composition files are in the P0 frozen set.
- The already registered single Send Intent detail route gains additive
  delivery-envelope and reconciliation diagnostics. This does not alter any
  Recommendation path, component closure, UI, or business rule.
- No Mail Center frontend integration was added because a production UI must
  not depend on an unregistered backend route.

### Task-Owned Files

Symbol-level changes in non-frozen files:

- `backend/core/src/modules/backlinks/application/queries/send-intent.query.ts`
  - immutable delivery envelope, queue derivation, and scoped list query
- `backend/core/src/modules/backlinks/api/send-intent.schema.ts`
  - additive detail fields and list request/response schemas
- `backend/core/src/modules/backlinks/api/send-intent.route.ts`
  - independent, currently unregistered collection route
- `backend/core/test/unit/send-intent.query.test.ts`
  - queue, envelope, scope, and keyset regressions
- `backend/core/test/backlinks/api/send-intent-route.test.ts`
  - detail and collection route contract regressions

Official mechanically generated artifacts:

- `backend/contracts/openapi/backlinks.v1.json`
- `backend/contracts/openapi/platform.v1.json`
- `frontend/src/api/generated/backlinks.ts`

There is no task-owned delta in
`backend/core/src/modules/backlinks/runtime/production-runtime.ts`,
`backend/core/src/modules/backlinks/api/private-server.ts`,
`backend/core/src/index.ts`, or any other path in the exact 94-file P0 frozen
set. Historical checkout changes in those files remain untouched and are not
attributed to this task.

### Checkpoint Report

- Focused Core tests: 2 files, 16 tests passed.
- Core typecheck: passed.
- Backlinks OpenAPI check: passed with 79 paths.
- Shared contract/freeze tests: 6 passed, 239 paths, 269 operations.
- Generated Backlinks client: valid with 80 operations.
- The unregistered operation `backlinksListSendIntentsV1` is absent from the
  Backlinks OpenAPI, aggregate Platform OpenAPI, and generated client.
- P0 source fingerprint: exact 94-file path set and
  `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689`.
- Frozen Recommendation semantic closure:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`;
  semantic diff zero.
- Full Backlinks OpenAPI SHA-256 after the permitted additive Send Intent
  detail fields:
  `8eb3f19205e5ca8e66388d5e2ab9a03e721b8135d16d9caa0fd531917dcf2677`.
  This aggregate change is outside the frozen Recommendation paths.
- Provider calls/cost: DataForSEO 0, Gmail 0, AI 0, Direct Monitor 0, USD 0.
- Database/migration/deployment effects: none. No migration was applied and no
  database write, Worker unlock, refill, request, lease, ledger, or deployment
  action was performed.

### Blocked Boundary

- Runtime gap: production query forwarding and collection-route registration
  require edits to P0-frozen composition files. Those edits are prohibited, so
  the queue collection endpoint is not runtime reachable.
- Frontend gap: Mail Center cannot be connected to an endpoint that is not in
  the public OpenAPI/generated client.
- Provider gap: no real Gmail send, synchronization, or reply matching was
  performed.
- Human-approval gap: no real send confirmation or reply-workbench acceptance
  was performed.
- Deployment gap: no runtime or generated artifact was deployed.
- UAT gap: no end-to-end Gmail readiness, send, reconciliation, or reply
  workbench flow was executed.

P4 and the overall plan therefore remain `BLOCKED`. P5-P8 were not started,
because continuing would violate the mandatory stop boundary after frozen
production wiring became necessary.

## P4A Controlled Shared-Hotspot Execution Amendment

Status: TESTED

Authorization date: 2026-08-22

The P4 stop boundary above records the state before controlled shared-hotspot
authorization. This amendment authorizes only the minimum additive Send Intent
list wiring. Recommendation generation, queries, commands, handlers, admission,
scoring, publication, inventory, contact discovery, UI, public operations, and
data semantics remain frozen.

### Preserved Original P0 Handoff Baseline

- Exact frozen path set: 94 paths.
- Path-list SHA-256:
  `06c6b93f65816e7fd011e5df869a2ec264d4324c6d018f700fc3ceef244edf5d`.
- Original source fingerprint:
  `11c5c6d0e7aed23a4bcfb28427ac3a068e62103421aeddfa3548cf7609154689`.
- Recommendation recursive OpenAPI semantic closure:
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`.

These values remain the immutable original handoff record. The post-integration
guard must not replace or rebaseline them.

### Shared-Hotspot Preimage And Ownership Snapshot

The checkout was already broadly dirty before P4A. The following current
preimages are the P4A task boundary; all earlier bytes and Git differences are
historical and not task-owned.

| Shared hotspot | P4A preimage SHA-256 | Historical diff vs HEAD |
|---|---|---|
| `backend/core/src/modules/backlinks/runtime/production-runtime.ts` | `af54bea7add0ae9e7c980b8d9b35e3d805ee0d04296611022dfda33d227b5f58` | `+510/-267` |
| `backend/core/src/modules/backlinks/api/private-server.ts` | `01421ceab80d79eef2e7fd536d6beaefcd7c2303045b8a6de86df828a070cb23` | `+35/-1` |
| `backend/core/src/index.ts` | `840e31f28513465a87c22883eccd4bcf63beaf9bcb5f19b79404787915cdd5c3` | `+68/-4` |

The last committed history touching these hotspots predates this task; the most
recent shared commit is
`de5f43b57289aa5b625d2e4505299b33e72b58e8` from 2026-08-14. No historical
dirty change will be cleaned, formatted, overwritten, or attributed to P4A.

### Exact Additive Symbol Allowlist

- `production-runtime.ts`
  - `SendIntentListQuery` type import
  - `sendIntentListFactory`
  - `queries.listSendIntents` scoped forwarding
- `private-server.ts`
  - `SendIntentListQuery` type import
  - `registerBacklinksSendIntentListRoute` import
  - `BacklinksApiQueries` list-query capability
  - one `registerBacklinksSendIntentListRoute` registration
- `index.ts`
  - no change currently authorized or required

The upgraded source guard must preserve the exact 94-path set, keep all 91
non-hotspot files byte-for-byte frozen, reconstruct each hotspot preimage after
removing only the allowlisted additions, and retain the independent
Recommendation OpenAPI closure check.

### Post-Integration Shared-Hotspot Evidence

| Shared hotspot | Post-integration SHA-256 | Task-owned additive symbols |
|---|---|---|
| `backend/core/src/modules/backlinks/runtime/production-runtime.ts` | `b6259e4dc85c1bb4420962235ef1c5d8cd297d217baa6d41f375eec0811c021b` | Send Intent list query factory/forwarding; Placement Candidate reply/placement lineage persistence and replay projection |
| `backend/core/src/modules/backlinks/api/private-server.ts` | `50e4a23b3135718751d3d8c86e75df3d578dee54a64d121a645aa562c80d3799` | Send Intent list query capability and route registration |
| `backend/core/src/index.ts` | `840e31f28513465a87c22883eccd4bcf63beaf9bcb5f19b79404787915cdd5c3` | none |

The final guard:

- reconstructs the original hotspot preimages after removing only the exact
  additive allowlist;
- preserves the 91 non-hotspot aggregate SHA-256
  `8121016b68f7a92f3b7a2f7cad83e603a23c841b2be39d85a2e80bd3d2c575e3`;
- preserves 119 Recommendation anchors with SHA-256
  `7ce2c0bfb367d92ad8a28508c191c2fb97c517dd3e4991533b64df439abbff27`;
- preserves the exact Recommendation semantic closure
  `ec0dc3d6aca9bd6fb4d920cfc7b9c1d4cdb886a0b9b755dc4f1eab62af8c129c`.

No Recommendation import, registration, handler, operation, reachable schema,
UI behavior, or business semantic changed.

## P4 Resumed - Gmail Readiness, Send And Reply Workbench

Status: TESTED

The historical P4 `BLOCKED` result above is retained as the state before P4A
authorization. P4A supplied only the missing additive runtime/query route
wiring. The production Mail Center now consumes the generated Core contract
for Gmail readiness, Send Intent list/detail, queue state, immutable delivery
envelope, `DELIVERY_UNKNOWN` reconciliation, reply projection, and ambiguous
reply confirmation. The frontend does not reimplement the readiness evaluator
or send-safety policy.

### Task-Owned Changes

- `backend/core/src/modules/backlinks/application/queries/send-intent.query.ts`
  - scoped keyset list, immutable delivery envelope, queue state, and runtime
    diagnostics
- `backend/core/src/modules/backlinks/api/send-intent.schema.ts`
  - list/detail public DTO additions
- `backend/core/src/modules/backlinks/api/send-intent.route.ts`
  - project-scoped list route and existing detail projection
- `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
  - exact P4A list factory and scoped forwarding allowlist
- `backend/core/src/modules/backlinks/api/private-server.ts`
  - exact P4A route registration allowlist
- `frontend/src/features/outreach/mail/send-intent-queue.tsx`
  - server-authoritative queue/detail/reconciliation UI
- Symbol-level Mail Center adapter, type, fixture, and source-test additions in
  `frontend/src/features/outreach/mail/` and
  `frontend/test/support/outreach-api-fixtures.ts`
- Focused Core and frontend regression additions for readiness changes,
  duplicate-send protection, accepted-but-unknown behavior, thread matching,
  project isolation, ambiguous reply confirmation, and stale request isolation

### Checkpoint Report

- Focused Core P4 suite: 80 tests passed during the checkpoint.
- Final combined P4/P6 Core regression: 5 files, 25 tests passed.
- Frontend outreach source suite: 38 tests passed.
- Local browser contract replay: desktop and mobile P4 flows passed with
  fixture-backed APIs and no real Gmail action.
- Core typecheck and frontend typecheck: passed.
- Backlinks OpenAPI and generated client: generated/check chain passed.
- Recommendation semantic diff: zero.
- Provider calls/cost: DataForSEO 0, Gmail send/sync 0, AI 0,
  Direct Monitor 0, USD 0.
- Database/migration/deployment effects: none.
- Downstream handoff: the confirmed reply identity is available to P5 as a
  project-scoped lineage input; real Gmail send/reply UAT remains unclaimed.

## P5 Reply And Negotiation To Placement

Status: TESTED

Core remains the only write owner. Existing mailbox and manual-cooperation
reply/negotiation timelines are reused; the task adds durable Placement lineage
so outreach-derived records carry the exact
`projectId/opportunityId/replyId/placementId` chain. Imported or unmatched
links remain explicitly unattributed and cannot claim outreach derivation.

### Task-Owned Changes

- `backend/core/src/modules/backlinks/db/migrations/0074_backlink_placement_reply_lineage.sql`
  - expand-and-contract lineage columns, constraints, indexes, and foreign keys
- `backend/core/src/modules/backlinks/db/schema/placements.ts`
  - source-model parity for candidate and Placement lineage
- `backend/core/src/modules/backlinks/application/commands/placement-candidate.command.ts`
  - reply lineage validation and deterministic planned Placement identity
- `backend/core/src/modules/backlinks/application/repositories/placement-review.repository.ts`
  - lineage-preserving confirmation and idempotent replay
- `backend/core/src/modules/backlinks/application/repositories/placement-validation.repository.ts`
  - lineage-preserving validation promotion
- `backend/core/src/modules/backlinks/application/schemas/placement-candidate.schema.ts`
  and `backend/core/src/modules/backlinks/api/placement-candidates.route.ts`
  - public lineage contract
- Exact additive lineage symbols in
  `backend/core/src/modules/backlinks/runtime/production-runtime.ts`
- `backend/core/test/unit/placement-reply-lineage-migration.test.ts` and focused
  placement route/repository regressions
- Generated OpenAPI/client artifacts updated only by the official chain

### Checkpoint Report

- P5 focused tests: 2 files, 5 tests passed.
- Migration manifest check: 67 files valid through `0074`.
- Migration SHA-256:
  `9f401710b75756a5732e145971d2b7fcfb95fc56c981c15ff458a3b27babae6a`.
- Cross-project reply evidence is rejected; only an exact confirmed,
  non-ambiguous reply may produce `OUTREACH_DERIVED`.
- Duplicate candidate creation and confirmation retain idempotent lineage.
- Imported/manual unmatched inventory remains `UNATTRIBUTED`.
- Recommendation semantic diff: zero.
- Provider calls/cost: all zero.
- Database/migration/deployment effects: migration created and validated but not
  applied; no SQL or DB write was executed.
- Downstream handoff: P6 can read stable Placement lineage and must continue to
  exclude Candidate records from monitoring KPI.

## P6 Monitoring Read Model

Status: TESTED

Backlinks owns Placement monitoring commands and facts. Platform Performance
owns the project-facing read endpoint and forwards to the Core projection; it
does not connect directly to the Core database.

### Task-Owned Changes

- `backend/core/src/modules/backlinks/application/queries/placement-links.query.ts`
  - project-scoped keyset list/detail projection, monitoring state, summary,
    evidence cutoff/freshness, and last-success preservation
- `backend/core/src/modules/backlinks/application/schemas/placement-links.schema.ts`
  - list/detail monitoring and lineage DTOs
- `backend/core/test/unit/placement-links-query.test.ts`
- `backend/core/test/backlinks/api/placement-links-route.test.ts`
- `backend/api/app/core/backlinks_gateway.py`
  - strict selected upstream path forwarding with unsafe path/query rejection
- `backend/api/app/modules/performance/schemas.py`
  - Performance Backlinks read DTO
- `backend/api/app/api/routes/performance.py`
  - `GET /api/v1/projects/{project_id}/performance/backlinks`
  - operationId `get_project_backlink_performance_v1`
- Focused Platform gateway, Performance API, and shared-contract tests
- `frontend/scripts/generate-backlinks-client.mjs`
  - exact additional BFF operation allowlist
- Generated client updated by the official generator only

### Checkpoint Report

- Core monitoring/P4 regression: 5 files, 25 tests passed.
- Platform focused tests: 30 passed.
- Shared contract checker: 241 public paths, 271 operations, one cross-module
  command, one cross-module event, and four Task Queues.
- Core Backlinks OpenAPI: 80 paths.
- Generated Backlinks client: valid with 82 operations.
- Candidate count is separate and always excluded from Placement KPI.
- States covered: pending verification, active, suspected changed, changed,
  suspected lost, lost, and recovered.
- Provider timeout/failure retains the last successful immutable observation.
- DataForSEO evidence and Direct Monitor evidence remain distinct.
- Recommendation semantic diff: zero.
- Provider calls/cost and database/deployment effects: all zero.
- Downstream handoff: P7 consumes the stable Performance BFF list and Core
  detail/evidence/reverify contracts.

## P7 Effects UI

Status: TESTED

The `Performance > Backlinks` view is implemented after the backend contract
and generated client. Existing Links and Reports entries remain available.
Production UI data comes only from generated API adapters; no static backlink
records or test fixtures enter the runtime bundle.

### Task-Owned Changes

- `frontend/src/features/performance/backlinks/backlink-monitoring-workspace.tsx`
  and focused component tests
- `frontend/src/features/performance/performance-workspace.tsx`
  - Backlinks view routing while preserving article performance views
- `frontend/src/features/performance/manifest.ts`
- `frontend/src/app/platform-navigation.ts` and its contract test
- `frontend/src/data/mock-data.ts`
  - runtime registry references the shared manifest object
- `frontend/src/api/performance.ts`
  - generated BFF list and Core detail/evidence/events/reverify adapters
- `frontend/src/features/outreach/outreach-workspace.tsx`
  - same-project Performance return path validation
- `frontend/src/features/outreach/links/links-workspace.tsx`
  - generated Placement detail compatibility without local lineage synthesis
- `frontend/test/support/outreach-api-fixtures.ts`
- `frontend/test/performance-backlinks.spec.ts`

### Checkpoint Report

- Focused component/navigation tests: 3 files, 19 tests passed.
- Outreach source suite: 38 tests passed.
- Links source suite: 7 tests passed.
- Frontend typecheck: passed.
- Production build: passed.
- Playwright: desktop Chromium and mobile Chromium, 2/2 passed.
- Browser coverage includes project-scoped KPI/list, Candidate exclusion,
  provider-failed historical evidence, detail lineage, evidence timeline,
  versioned reverify, unexpected-network rejection, responsive overflow, and
  mobile Sheet controls.
- Loading, no Placement, waiting-first-verification, partial Provider failure,
  historical data with failed latest attempt, API failure, and project request
  isolation are represented by contract/UI tests.
- Evidence labels distinguish DataForSEO, direct validation, Direct Monitor,
  Indexification, and indexing evidence.
- Recommendation semantic diff: zero; OpenAPI/client drift: zero.
- Provider calls/cost and database/deployment effects: all zero.
- Browser evidence is fixture-backed local validation, not deployed or
  real-Provider UAT.
- Downstream handoff: code and contracts are ready for the bounded P8 rollout
  and real lineage UAT.

## P8 Bounded Real UAT Boundary

Status: INPUT_REQUIRED

P0-P7 are `TESTED`; the overall P0-P8 product task is not `COMPLETE`.
The current zero-side-effect authorization does not permit the remaining
runtime facts. No Reply, Placement, monitoring observation, or success metric
was fabricated to close the task.

### Minimum Authorization Required

- Exact organization, workspace, Website Project, approved opportunity, and
  selected Gmail identity for one bounded UAT chain.
- Approval to deploy the tested contracts/runtime/UI to a named environment,
  with the previous artifact/version identified as the rollback point.
- Approval to apply migration `0074` in that environment after a preflight and
  backup/rollback check. No manual SQL is acceptable.
- Explicit Gmail send and sync ceilings, authorized scopes, one human-approved
  message, and one human-controlled real reply. The Gmail cost ceiling must be
  stated even if the Provider itself does not charge per message.
- Explicit Direct Monitor request ceiling and monetary ceiling for one
  Placement verification. No cost estimate is assumed in this document.
- Human approval for ambiguous-reply resolution, negotiation-fact correction,
  and final Placement confirmation.
- If a new recommendation or AI draft is required, separate explicit
  DataForSEO and AI request/cost ceilings before either Provider is enabled.

### Required P8 Evidence

- Pre/post tenant-scoped counts for recommendations, visible generation,
  Provider requests, active leases, ledger rows/cost, and `unknown_charge`.
- Gmail readiness and version pin before send; one immutable Send Intent;
  duplicate-send and `DELIVERY_UNKNOWN` reconciliation evidence.
- Exact thread/reply match, or an auditable human resolution for ambiguity.
- Persisted `projectId/opportunityId/replyId/placementId` lineage across reload,
  project switching, and a second browser session.
- One authorized Direct Monitor observation, historical evidence retention, KPI
  projection through Platform Performance, and reverify command ownership in
  Backlinks.
- Deployment version, migration head, rollback point, Provider request IDs,
  ledger/cost evidence, human approvals, and browser screenshots.

Until those approvals and runtime facts exist, P8 and the overall task remain
`INPUT_REQUIRED`.
