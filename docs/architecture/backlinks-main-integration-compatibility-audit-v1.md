# Backlinks Main Integration Compatibility Audit V1

> Effective date: `2026-08-15`
>
> Status: `M1_RECONCILIATION_COMPLETE_PHASE_0_COMPLETE`
>
> Target implementation repository:
> `C:\Users\DELL\Documents\缝合\john3947-seo-main`
>
> Target baseline: branch `main`, commit
> `2092d0da79cf8b126421369a9ca9db7fd4acd503`
>
> Compared legacy baseline:
> `C:\Users\DELL\Documents\缝合\john3947-seo`, branch `外链ver`, commit
> `de5f43b57289aa5b625d2e4505299b33e72b58e8`
>
> Coding entry:
> `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`

## 0. Current Reconciliation Status

This section is the current control. Sections 1 through 5 preserve the
pre-reconciliation audit and must not be read as the current gate state.

| Gate or fact | Current result |
|---|---|
| M1A | `GATE_SATISFIED_BY_RESOLUTION`: the original result remains `INPUT_REQUIRED`; its accepted input-resolution record, M1B closure, and M1C runtime evidence satisfy sequence control |
| M1B | `PASS` |
| M1C | `PASS` |
| Phase 0 | `PASS` |
| Platform Alembic head | `20260815_0065` |
| Backlinks SQL head | `0061` |
| Phase 1 | `NOT_AUTHORIZED` |

The M1 work established the integrated Project authority, persisted
archive/restore and Outreach Profile contracts, Shared SEO Evidence boundary,
one deployable migration graph, and integrated Core runtime evidence.
Historical findings below remain useful provenance. They do not reactivate an
old file list or prove later Recommendation, provider, AI, Gmail, Send/Sync,
or full product acceptance.

Current runtime still contains legacy V3 recommendation behavior and
production-facing Mock wording/import residue. Those are recorded remediation
debt, not accepted production evidence, and belong to their separately
authorized future phases.

## 1. Decision

The target `main` repository MUST NOT execute the existing Backlinks
remediation coding phases directly.

The business direction in
`backlinks-core-value-chain-remediation-v1.md` remains valid, and most
Backlinks Core vertical phases remain reusable. However, the integrated
repository changed the platform Project model, frontend Project Context,
migration graph, and local runtime ownership. A mandatory mainline integration
phase must pass before Recommendation, AI Draft, Gmail, or Send/Sync code is
changed.

Decision:

```text
direct execution of the old file-level plan
-> NO-GO

complete Phase M1A, Phase M1B, and Phase M1C Mainline Integration Reconciliation
-> CONDITIONAL GO for the existing vertical phases
```

This result is based on repository and source inspection only. It is not
build, migration, runtime, provider, Gmail, or UAT evidence.

## 2. Repository Relationship

The target `main` is not an unrelated replacement repository. Its history
contains the legacy Backlinks branch and then integrates a colleague's
platform work:

```text
de5f43b  feat: update Website Project backlink workflow
a0886bf  merge: integrate backlinks with platform projects
2092d0d  fix: complete backlinks platform integration
```

The integration is therefore a forward merge with substantial ownership
changes. The correct approach is to preserve the integrated platform and add
Backlinks-specific contracts where needed. Replacing the colleague's Project
system wholesale with the legacy Project implementation would create a second
platform architecture and is prohibited.

## 3. Material Compatibility Differences

| Surface | Legacy Backlinks baseline | Integrated `main` | Required decision |
|---|---|---|---|
| Project identity | Organization, Workspace, project key, lifecycle, context versions, promotion input versions | Platform Project contains organization and basic site fields; Backlinks gateway maps the Project ID as its key | Keep Platform Project as root identity; add missing lifecycle and Backlinks intent additively |
| Project-management entry | Sidebar switcher plus a Backlinks `projects` tab provided create, edit, archive, and restore | Production routes use global `/projects` and `CreateProjectDialog`; Backlinks manifest has no `projects` tab, while an unused `features/projects/project-workspace.tsx` still contains local Mock data | Keep `/projects` as the only Project center; add one App Shell switcher using the same Project Context; port archive/restore and profile editing into global Project management/settings; never mount the legacy or Mock workspace as a second authority |
| Website facts | Versioned Website Project inputs were directly available to Backlinks | `SiteProfile` and `SiteProfileVersion` hold machine-discovered website understanding | Keep SiteProfile as discovery evidence; do not treat it as user-approved outreach intent |
| Outreach intent | Keywords, products, target URLs, audiences, partnership goals, market and language scope were explicit versioned inputs | Current outreach projection derives a small subset from SiteProfile and always reports `外链合作目标` missing | Add a Backlinks-owned immutable Outreach Profile/Promotion Target version |
| Project authority | Backlinks contracts expected one tenant-scoped project authority | Backlinks gateway uses signed organization/workspace/project membership, while general Project CRUD uses `default_organization_id` | Align Project CRUD and Backlinks gateway to one authenticated tenant/project authority |
| Route project selection | Exact requested project was authoritative and stale reads were rejected | Project Context can return `projects[0]` for an invalid route ID; several outreach pages do not reject the mismatch | Never fall back to the first project for a project route; cancel and reject stale cross-project responses |
| Project lifecycle | Active/archive/restore semantics retained historical business facts | Current UI exposes destructive delete and no archive/restore lifecycle | Add `ACTIVE`/`ARCHIVED`; archive is normal removal, destructive purge is exceptional |
| Deletion | Business history was expected to remain project-attributed | Current Project service can continue forced deletion after Workflow or cleanup failures | A Project with Backlinks, Gmail, Reply, Placement, or Report history cannot use ordinary destructive delete |
| Production frontend | Production acceptance prohibited Mock fallback | Settings and an unused Project workspace still describe Gmail, DataForSEO, Temporal, and project data as Mock | Isolate prototype/demo modules and remove Mock status from production navigation and acceptance |
| Platform migrations | Legacy project-authority revisions and Core migration `0044` existed | Those revisions were removed while the integrated Alembic graph advanced through `0064`; Core jumps from `0043` to `0045` | Add compatibility bridges; never edit an already applied revision or assume only fresh databases exist |
| Deployment manifest | Backlinks plan expected current migration-head validation | Manifest records Alembic `20260724_0007` and Backlinks `0060`, but its test asserts a frozen partial file list and Backlinks `0031` | Replace false-confidence validation with an explicit current deployable graph plus frozen-source integrity checks |
| Local runtime | Legacy `ops/local-product` scripts owned Core provider and Worker activation | Those scripts were removed; `scripts/dev-up.ps1` starts platform API/frontend/infrastructure but not Backlinks Core API or Core Worker | Add one integrated Core runtime path before provider, Workflow, Gmail, or E2E acceptance |
| Plan paths | Existing coding plan names legacy `ops/local-product` files and one removed test | Ten explicitly referenced paths are absent from target `main` | Rebind every phase to current ownership before it is authorized |

## 4. Target Product And Architecture Contract

### 4.1 Project Fact Ownership

The integrated product uses three separate authorities:

```text
Platform Project
-> tenant identity, domain, lifecycle, root project ID

SiteProfile / SiteProfileVersion
-> machine-discovered and refreshable website facts

ProjectOutreachProfile / PromotionTargetVersion
-> user-confirmed and immutable Backlinks intent
```

The Backlinks outreach profile includes at least:

```text
keywords and topics
products or services
target URLs
target audiences
partnership goals
market/location/language scope
authorized discovery sources
version and immutable fingerprint
```

SiteProfile may propose values, but an automatic SiteProfile refresh MUST NOT
silently change the inputs of an active recommendation generation, AI draft,
or send snapshot.

### 4.2 Shared SEO Evidence Contract

The integrated product uses one Project and one shared SEO fact base. Source
modules keep ownership of their own facts; Backlinks reads them through a
stable contract instead of querying colleague-owned tables directly.

| Fact | Source authority | Backlinks use |
|---|---|---|
| Tenant, Project, domain, lifecycle | Platform Project | Required project identity |
| Website summary, products, audiences, topics, key pages | SiteProfile/versions | Outreach-profile proposals and semantic context |
| Keyword library and keyword metrics | Keyword module | Candidate discovery seeds and relevance context |
| Competitor, SERP, content, and GSC evidence | Owning platform module | Reusable discovery evidence when scope and freshness match |
| Outreach goals, target URLs, market/language, authorized sources | ProjectOutreachProfile/version | User-confirmed recommendation input |
| Candidate Traffic, Spam, Authority, accessibility, contact, and path evidence | Backlinks | Qualification and outreach execution |

The read contract is a versioned `SharedSeoEvidenceSnapshot` or equivalent
API/projection containing at least:

```text
organizationId
projectId
evidenceType
sourceModule
sourceRecordId or sourceVersion
provider and endpoint
normalizedParameters and requestFingerprint
market/location/language scope
fetchedAt and expiresAt
provider request/task identity when available
cost and provenance
payload or artifact reference
status
```

Rules:

1. Backlinks MUST NOT couple its domain services to the internal schemas or
   repositories of Project, Keyword, Content, Audit, or GSC modules.
2. A recommendation generation pins the exact Project, SiteProfile, Outreach
   Profile, keyword/evidence snapshot, traffic scope, and qualification
   contract versions used by that run.
3. Current real-provider evidence may be reused only for the same Project,
   normalized parameters, endpoint, market/language scope, and valid freshness
   policy. Stale, untraceable, or parameter-mismatched evidence is not reused.
4. Backlinks-specific candidate qualification remains Backlinks-owned.
   Traffic, Spam, and Authority evidence must come from a current authorized
   live artifact for that generation. The same persisted artifact may be
   reused for the same generation and request fingerprint; it is not paid for
   twice.
5. Browser refresh, route navigation, polling, Workflow replay, and service
   restart read persisted evidence and never trigger a paid request.
6. Provider credential/account health is shared product infrastructure.
   Module operations, budgets, retries, and failure states remain isolated so
   one module cannot silently disable another.
7. Phase M1A adds the read contract and adapter boundary. It does not rewrite
   every existing DataForSEO client into one provider service. A centralized
   provider coordinator may be considered later only after the shared
   contract is proven.

### 4.3 Project Lifecycle

Normal product lifecycle:

```text
ACTIVE
-> ARCHIVED
-> ACTIVE
```

Archiving stops new paid discovery, new drafting, new sends, and new scheduled
work for that project while preserving all historical evidence and reports.
Restoring re-enables work only after current provider, AI, Gmail, and Worker
readiness is recalculated.

Destructive purge is not a normal project-management action. It is allowed
only for an empty/new project or through a separately authorized retention
workflow that proves all dependent data can be removed consistently.

### 4.4 One Project Authority

All Project CRUD, SiteProfile, Backlinks gateway, Gmail binding, and frontend
project routes must resolve the same authenticated:

```text
organizationId
workspaceId
projectId
permissions
```

`default_organization_id` may remain an explicit local-development identity,
but it cannot be a hidden production authorization path.

The route `projectId` is exact. An unknown, deleted, unauthorized, or archived
project returns a truthful state. It never renders the first available
project and never sends a request under a different project key.

### 4.5 Canonical Project Entry And Navigation

Production uses one Project-management entry and one current-Project state:

```text
/projects
-> list, create, archive, restore, and enter Platform Projects

App Shell Project switcher
-> switches the exact route Project through the same Project Context

Project settings / Outreach Profile
-> edits user-confirmed Backlinks intent for that Project
```

The integrated `CreateProjectDialog` remains the only Project-creation command
and continues into SiteProfile/business-profile onboarding. The Backlinks
module contains Recommendation, Opportunity, and Mail views; it does not
create or manage a second Website Project.

The legacy `CurrentProjectProvider` and Backlinks `ProjectWorkspace` are not
copied wholesale. Their useful switch, archive/restore, detailed profile, and
recoverable-error behavior is ported into the integrated Project Context,
global Project center, and Project settings. The unused Mock
`frontend/src/features/projects/project-workspace.tsx` is isolated from
production imports and removed when no isolated prototype depends on it.

## 5. Mandatory Mainline Integration Reconciliation: M1A, M1B, And M1C

These three phases are hard prerequisites to every existing remediation phase.

### 5.1 M1A: Contract, Authority, And Route Safety

M1A freezes the integrated contracts and fixes exact Project routing without
adding new persistence or changing runtime startup.

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

Required work:

1. Keep `/projects` and the integrated `CreateProjectDialog` as the only
   Project-management and creation entry.
2. Add or retain one App Shell Project switcher backed by the same exact
   Project Context and route identity.
3. Keep Platform Project as root tenant identity and SiteProfile as
   machine-discovered website evidence.
4. Define Project lifecycle, versioned Backlinks Outreach Profile, Shared SEO
   Evidence, generation pins, and archive/delete dependency contracts without
   claiming persistence.
5. Make Project CRUD and Backlinks gateway use one tenant/project authority.
6. Remove frontend first-project fallback, cancel stale polling, and reject
   late cross-project responses.
7. Preserve each source module as authority for its own facts and prohibit
   direct Backlinks reads of colleague-owned internal tables.
8. Keep the Backlinks manifest free of a `projects` tab; isolate the unused
   Mock Project workspace from production routes and acceptance.
9. Define Backlinks profile editing as Project settings/Outreach Profile
   behavior, not a second Project record or creation command.
10. Regression-test colleague-owned Project, SiteProfile, crawler, audit,
   keyword, content, GSC, and agent flows touched by these contracts.
11. Do not expose placeholder lifecycle, Outreach Profile, or generation-pin
   values from a production API before M1B can persist them truthfully.

M1A must not create migrations, persist lifecycle or Outreach Profile state,
change Core startup, or call DataForSEO, Browser, AI, or Gmail.

### 5.2 M1B: Additive Persistence And Migration Compatibility

M1B implements the approved M1A contracts with additive storage and proves one
forward-upgradable database graph.

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

Required work:

1. Add persisted Project `ACTIVE`/`ARCHIVED` lifecycle and archive/restore APIs.
2. Add immutable, versioned Backlinks Outreach Profile persistence.
3. Persist Shared SEO Evidence references and generation input pins without
   copying colleague-owned source tables into mutable Backlinks truth.
4. Enforce archive/delete dependency guards that preserve Backlinks, Gmail,
   Reply, Placement, Links, and Report history.
5. Restore upgrade continuity for removed legacy Alembic revisions and Core
   migration `0044` through additive compatibility bridges.
6. Make migration validation distinguish frozen historical integrity from the
   current deployable Alembic and Backlinks heads.

M1B must not change Core startup or perform a provider, paid AI, Gmail
authorization, or Gmail send action.

### 5.3 M1C: Integrated Core Runtime Reconciliation

M1C integrates the existing Backlinks Core services into the current local
runtime after M1B persistence and migrations pass.

```text
backend/api/app/core/backlinks_runtime_status.py
backend/core/src/modules/backlinks/runtime/
scripts/dev-up.ps1
scripts/dev-down.ps1
deploy/compose/.env.example
deploy/compose/compose.yaml
```

Required work:

1. Add Backlinks Core API and Core Worker to the integrated local runtime and
   provide one current configuration source for DataForSEO, Browser, AI,
   Gmail, signed project context, and gateway target.
2. Expose API health separately from Worker execution health so an alive API
   with a stopped or quiesced Worker cannot appear operational.
3. Preserve provider-disabled test/CI startup and ensure startup, restart,
   refresh, polling, and Workflow replay create no paid action.

The exact file list for every phase is re-read from `main` before coding. No
other task may edit that phase's files in parallel.

### 5.4 Required Verification

M1A contract and frontend:

- `/projects` is the only Project-management entry and Project creation issues
  one Platform Project command;
- the App Shell switcher and global Project center select the same exact
  Project ID;
- Backlinks has no production `projects` tab and no Mock Project workspace
  import;
- an invalid or unauthorized route never displays another project;
- switching projects cancels old polling and rejects late responses;
- colleague-owned Project creation, SiteProfile, crawling, audit, keyword,
  content, and agent flows remain green.

M1A shared evidence:

- Backlinks reads current matching Project/keyword/competitor/SERP facts
  without asking the user to enter them again;
- a parameter, market, language, freshness, Project, or source-version mismatch
  is rejected rather than silently reused;
- contract validation requires explicit versions and rejects substitution of
  a changed SiteProfile, keyword, or Project snapshot;
- Backlinks qualification evidence remains attributable to its generation and
  cannot be replaced by an unrelated keyword/content provider response;
- page refresh, polling, restart, and Workflow replay issue zero new paid
  requests;
- provider credential or balance failure has one truthful shared reason while
  unrelated module state machines remain enabled.

M1B persistence and migration:

- Project edits persist after refresh;
- archive preserves Backlinks, Gmail, Reply, Placement, Links, and Report
  history;
- restore recalculates readiness and does not automatically create paid work;
- ordinary delete cannot orphan cross-module business history;
- an already persisted generation keeps its pinned inputs after Project,
  SiteProfile, keyword, or Outreach Profile edits;
- a fresh database upgrades to the current Alembic and Backlinks heads;
- a database at legacy Alembic revision `20260813_0010` upgrades through a
  reviewed compatibility path;
- a database that already applied Backlinks migration `0044` upgrades without
  replaying, renumbering, or losing that revision;
- project, Backlinks, Gmail, Reply, Placement, and Report data are preserved;
- startup and deployment validation identify the actual current heads;
- Platform OpenAPI is regenerated from the persisted backend contract, and
  frontend mappings consume no state the backend cannot produce.

M1C runtime:

- `scripts/dev-up.ps1` or its documented successor starts Platform API,
  frontend, Backlinks Core API, and Backlinks Core Worker;
- health identifies Core API alive, Worker running, Worker paused/quiesced,
  provider configured, and provider externally unavailable as different facts;
- ordinary restart preserves desired DataForSEO enabled, Browser enabled, and
  DataForSEO Kill Switch `blocked=false`;
- no provider request, Gmail send, or paid AI call is needed to prove startup
  wiring.

### 5.5 Exit Criterion

The mainline reconciliation is complete only when all of the following are
true:

```text
one project identity and tenant authority
one Project-management entry and current-Project state
exact route project behavior
archive/restore lifecycle
versioned outreach intent
versioned shared SEO evidence boundary and generation input pins
fresh and legacy database upgrade continuity
current migration-head validation
Core API and Worker integrated into local runtime
no production Mock fallback
no regression in colleague-owned project workflows
```

Until M1A, M1B, and M1C all pass, Recommendation, AI Draft, Gmail, and
Send/Sync coding is `BLOCKED_BY_MAINLINE_INTEGRATION`.

## 6. Impact On Existing Remediation Phases

| Existing phase | Status on integrated `main` |
|---|---|
| Phase 0 contract guard | Retained, but must name the target commit and this compatibility audit |
| Phase 1 provider configuration | Retained after Core runtime ownership is established; legacy `ops/local-product` paths are invalid |
| Phase 2 additive compatibility | Retained, but must use the integrated Alembic/Core migration compatibility strategy |
| Phase 3 AI budget split | Retained; must not reuse colleague-owned business-profile AI ledger as Backlinks draft/discovery authority without an explicit adapter |
| Phase 4 bounded qualification | Retained; depends on versioned Outreach Profile, pinned Shared SEO Evidence, and a running Core Worker |
| Phase 5 visibility | Retained; frontend must first have exact project routing and stale-response protection |
| Phase 6 cooperation paths | Retained; Project archive and non-email lineage must remain project-attributed |
| Phase 7 AI draft | Retained |
| Phase 8 Gmail readiness | Retained; project/workspace authority must already be unified |
| Phase 9 send/sync | Retained; Core Worker health and exact project binding are prerequisites |
| Phase 10 full closure | Retained; must regression-test colleague-owned project navigation and reporting integration |

## 7. Execution Order

The historical approved order was:

```text
copy the normative remediation documents into the target main worktree
-> re-read main HEAD and dirty state
-> execute Phase M1A contract/authority/route reconciliation only
-> stop and review its result
-> execute Phase M1B persistence/migration reconciliation only
-> stop and review its result
-> execute Phase M1C integrated-runtime reconciliation only
-> stop and review its result
-> execute Phase 0
-> execute Phases 1 through 10 one at a time
```

M1A through M1C and Phase 0 have now reached the current results recorded in
Section 0. The next possible unit is Phase 1 only, and it remains locked until
an exact new authorization. No business code, migration, provider call, Gmail
authorization change, or send was performed by Phase 0.
