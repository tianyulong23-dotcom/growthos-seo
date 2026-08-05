# Shared Module Ownership

> Date: 2026-07-24
> Status: path/review rules accepted through `BL-AI-ARCH-003`; shared database,
> contract namespace, and frontend registration gates proven through
> `BL-AI-ARCH-007`; required `BL-AI-ARCH-008` follow-up roles staffed on
> 2026-07-24 through the repository-local review record; `SEO4-INT-004`
> dual-migration ownership is repository-proven on PostgreSQL 18.4;
> `SEO4-INT-006` proves the evidence-only Go crawler adapter

This document prevents two modules from owning the same route, data, workflow,
or shared path. Evidence labels describe current observations. `ACCEPTED`
describes an architecture decision made by ADR-BL-0003 and is not a claim that
the corresponding runtime adapter is already implemented.

## Evidence Rules

| Label | Meaning |
|---|---|
| `PROVEN` | Confirmed by code, command, runtime evidence, test, or owner |
| `DECLARED` | Stated by an external technical document but not verified against its repository or runtime |
| `INFERRED` | Likely from repository structure but not directly verified |
| `UNKNOWN` | Not currently known |
| `ACCEPTED` | Architecture ownership or topology fixed by an accepted ADR |

## SEO V4 External Integration Overlay

Date: `2026-07-24`.

- The fetched `john3947/seo` baseline is frozen at
  `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`. The coworker's
  `E:\seo-v4` drive label is not treated as a required local path.
- FastAPI, Project/Audit models, six Alembic revisions, PostgreSQL 18 target,
  Temporal declarations, object-storage rules, and the Go crawler source are
  `PROVEN` repository inputs. Authenticated owner approval and production
  deployment remain `UNKNOWN`.
- The current repository has independently proved
  `SHARED-REPO-GATE = PASS`, `SEO-V4-ROUTE-GATE = PASS`, and
  `SEO-V4-CRAWLER-GATE = PASS`; `BL-AI-080` and `SEO4-INT-006` are complete.
  The next prescribed task at this integration point is `BL-AI-081`.
- The target ownership split is Platform for Project/Auth/context facts, Audit
  for audit conclusions, Crawling for crawl jobs/evidence/artifacts, and
  Backlinks for Opportunity, outreach, Placement, and lifecycle facts.
- A crawler result, including `backlink_validation`, is evidence only. It may
  not directly set final Audit or Backlinks business state.
- Existing local role staffing records do not prove ownership of paths in the
  coworker's external repository. Exact external owners, paths, migrations,
  routes, contracts, queues, and deployment configuration remain `UNKNOWN`
  until the `SEO-V4-REPO-GATE` reads the real repository.
- No local owner assignment permits overwriting coworker Projects, Audit,
  Crawler, shared frontend, Compose, or Alembic paths without the affected
  owner's review.

## Owner Roles And Staffing

An Owner role is the single accountable repository or domain slot. It is not a
person, Git author, or GitHub account. Required roles for
`BL-AI-ARCH-008-FU-001` are staffed by the exact repository-local assignee
identifier `tianyulong23-dotcom`. This identifier is approved for the paths in
the dated review record below; it is not a claim of authenticated GitHub
ownership.

| Owner role | Accountable scope | Named human |
|---|---|---|
| `ROLE-PLATFORM-API` | Public FastAPI Gateway, public route composition, authentication boundary, and gateway adapters | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-PLATFORM-CONTEXT` | Organization, Workspace, Website Project, membership, and `PlatformRequestContext` authority | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-PLATFORM-CONTRACTS` | Shared contract registry and aggregate public OpenAPI | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-PLATFORM-DATABASE-OPERATIONS` | Shared PostgreSQL role/schema bootstrap, privileged migration execution, physical backup, restore, and recovery evidence | `UNKNOWN`: approval blocked |
| `ROLE-PLATFORM-FRONTEND` | App Shell, main routing/navigation, shared API transport, global presentation, and shared UI composition | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-PLATFORM-WORKERS` | Shared Python Worker registry and cross-module Worker composition | `UNKNOWN`: approval blocked |
| `ROLE-ARCHITECTURE` | Shared architecture records and cross-module ownership decisions | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-AUDIT` | Audit domain facts and module-private implementation | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-KEYWORDS` | Keywords domain facts and module-private implementation | `UNKNOWN`: approval blocked |
| `ROLE-CONTENT` | Content domain facts and module-private implementation | `UNKNOWN`: approval blocked |
| `ROLE-BACKLINKS` | Backlinks domain, private Core API, Worker, migrations, module contract, and module-private frontend | `tianyulong23-dotcom`; approved 2026-07-24 |
| `ROLE-CRAWLER` | Go crawler capability and its future owned contracts | `UNKNOWN`: approval blocked |
| `ROLE-BROWSER-WORKER` | Browser rendering capability and its future owned contracts | `UNKNOWN`: approval blocked |
| `ROLE-PERFORMANCE` | Performance feature path; product/data authority remains unresolved | `UNKNOWN`: approval blocked |

`BL-AI-ARCH-003` did not invent names. `BL-AI-ARCH-008-FU-001` staffs only the
roles required by its approved path set. A role becomes staffed only after an
authorized decision records the person's or team's exact identity here and in
an adopted review record, or in an adopted `CODEOWNERS` file. Any change
requiring an unstaffed role remains blocked from merge or direct push.

## Product Capabilities

| Capability | Current implementation fact | Write authority | Public entry | Human owner |
|---|---|---|---|---|
| Identity, Organization, Workspace, Project, Membership | `PROVEN`: FastAPI verifies signed Actor/Membership claims, reads the frozen `projects` master model through a read-only authority, binds organization/workspace/Project/permission facts, and defaults to a rejecting resolver. Alembic plus the ownership bridge place `projects` and `site_profiles` in `platform` with forced RLS; production identity issuance and migration application remain `UNKNOWN` | `ACCEPTED`: Platform authority | `ACCEPTED`: FastAPI Platform Gateway | `ROLE-PLATFORM-CONTEXT`; assignee `tianyulong23-dotcom` |
| Website crawl and technical audit findings | `PROVEN`: the frozen Alembic chain plus the ownership bridge place seven evidence tables in `crawling` and two conclusion tables in `audit`, with separate writers and forced RLS. The adapted Go Worker implements the versioned Crawling Temporal contract and writes only object-store evidence; production deployment remains `UNKNOWN` | `ACCEPTED`: Crawling owns evidence; Audit owns conclusions | `ACCEPTED`: Platform Gateway for Audit routes; Crawler remains private | `ROLE-AUDIT`; assignee `tianyulong23-dotcom`; `ROLE-CRAWLER` named human `UNKNOWN` |
| Keyword sets, ranks, volumes, analysis | `PROVEN`: frontend mock UI and an empty `backend/api/app/modules/keywords` package; no route, model, migration, or module Worker found | `ACCEPTED`: Keywords authority; implementation remains `UNKNOWN` | `ACCEPTED`: Platform Gateway when routes exist | `ROLE-KEYWORDS`; named human `UNKNOWN` |
| Content brief, draft, publication, content metrics | `PROVEN`: frontend mock UI and an empty `backend/api/app/modules/content` package; no route, model, migration, or module Worker found | `ACCEPTED`: Content authority; implementation remains `UNKNOWN` | `ACCEPTED`: Platform Gateway when routes exist | `ROLE-CONTENT`; named human `UNKNOWN` |
| Recommendation, Prospect, Contact | `PROVEN`: implemented under `backend/core/src/modules/backlinks` with HTTP contract, migrations, and a runnable private Fastify bootstrap; disposable runtime passed and persistent deployment remains `UNKNOWN` | `ACCEPTED`: Backlinks Core is sole write authority | `ACCEPTED`: Platform Gateway proxies to private Backlinks Core | `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom` |
| Opportunity, Cycle, Cooperation, Placement, Monitoring | `PROVEN`: no corresponding persistence or business route is implemented; frontend labels and generic test fixture strings are not backend facts | `ACCEPTED`: future Backlinks Core authority | `ACCEPTED`: Platform Gateway when routes exist | `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom` |
| Cross-module dashboards and reports | `PROVEN`: frontend mock composition exists; backend projection implementation not found | `ACCEPTED`: read-only projection/aggregation only | `ACCEPTED`: Platform Gateway | `ROLE-PLATFORM-FRONTEND`; assignee `tianyulong23-dotcom` |

## Backend Paths

| Path | Current fact | Change policy | Ownership |
|---|---|---|---|
| `backend/core/**` | `PROVEN`: package name is `@growthos/backlinks-core`; source, tests, migrations, scripts, ADRs, and generated governance artifacts are Backlinks-only | `ACCEPTED`: retain in place as the Backlinks-exclusive package; no other module may add code here; no bulk move or parallel copy | Exclusive path owner `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom` |
| `backend/contracts/**` | `PROVEN`: shared contract directories plus the generated Backlinks module OpenAPI | `ACCEPTED`: shared registry; producer modules own their source contract while Platform owns aggregation and registry rules | Path owner `ROLE-PLATFORM-CONTRACTS`; affected producer role must co-review |
| `backend/contracts/openapi/backlinks.v1.json` | `PROVEN`: generated contract with eight Backlinks operations | `ACCEPTED`: Backlinks generates the module contract; Platform Gateway aggregates it without reimplementing commands | Source owner `ROLE-BACKLINKS`; registry/public aggregation reviewer `ROLE-PLATFORM-CONTRACTS` |
| `backend/database/**` | `PROVEN`: shared role/schema bootstrap, dual-migration deployment manifest, and disposable PostgreSQL 18 clean/upgrade/restore gate exist; no credential or business table definition is owned here | Shared database infrastructure only; Alembic owns Platform/Crawling/Audit objects and Backlinks SQL owns only `backlinks` | Path owner `ROLE-PLATFORM-DATABASE-OPERATIONS`; `ROLE-ARCHITECTURE` and every affected module role must co-review |
| `backend/api/**` | `PROVEN`: FastAPI exposes Platform health and exactly seven Backlinks runtime adapters, verifies signed Platform access claims, resolves the authoritative Project read-only, and signs internal context; aggregate OpenAPI is generated separately; Audit/Keywords/Content module packages remain empty | `ACCEPTED`: shared public Gateway composition; domain adapters may dispatch but may not own module writes | Exclusive path owner `ROLE-PLATFORM-API`; affected domain role must co-review adapters |
| `backend/workers/**` | `PROVEN`: generic Python CLI registry only; no running Temporal Worker | Shared registration/composition only; no product fact ownership from a registry label | Exclusive path owner `ROLE-PLATFORM-WORKERS`; affected module role must co-review registration |
| `backend/crawler/**` | `PROVEN`: adapted Go crawler implements SafeFetch, robots/rate/size/cancel controls, static-first plus conditional Browser fetching, versioned Temporal bindings, and SHA-256 object-store evidence; it has no database dependency or business writes | Module-private evidence capability; Project/Audit/Backlinks consumers decide and write their own facts | Exclusive path owner `ROLE-CRAWLER`; named human `UNKNOWN` |
| `backend/browser-worker/**` | `PROVEN`: renderer capability list and test; no start script or running Worker | Module-private capability path; no product writes or database credentials | Exclusive path owner `ROLE-BROWSER-WORKER`; named human `UNKNOWN` |
| `backend/services/backlinks-core/**` | `PROVEN`: path does not exist | `ACCEPTED`: prohibited as a parallel Backlinks implementation; a future move requires a separate ADR and atomic migration plan | No active owner because the path must remain absent |
| `docs/architecture/**` | `PROVEN`: shared architecture directory exists and is untracked | Shared architecture review plus every affected module role | Exclusive path owner `ROLE-ARCHITECTURE`; assignee `tianyulong23-dotcom` |

### Backlinks Path Decision

`backend/core/**` is retained as the final path mapping for the existing
Backlinks package and for original tasks `BL-AI-074` through `BL-AI-197`.
The generic directory name does not make the package shared: its package name
and complete implementation inventory establish Backlinks exclusivity.

No code is moved by `BL-AI-ARCH-003`. A later rename is allowed only through a
separate accepted ADR, a no-parallel-copy migration plan, import/build/test
evidence, and approval from `ROLE-BACKLINKS` plus `ROLE-ARCHITECTURE`.

## Frontend Paths

| Path | Current fact | Change policy | Ownership / risk |
|---|---|---|---|
| `frontend/src/App.tsx` | `PROVEN`: consumes registered module routes plus Platform-owned Overview, Performance, and Settings routes | Main route registration only; impacted module routes require joint review | Path owner `ROLE-PLATFORM-FRONTEND`; affected module roles co-review; risk High |
| `frontend/src/app/**` | `PROVEN`: App Shell, module contract/registry, shared navigation, and prototype Project Context live here | Shared shell, navigation, registration, and Project Context composition only; no module-private business state | Path owner `ROLE-PLATFORM-FRONTEND`; `ROLE-PLATFORM-CONTEXT` and affected module roles co-review; risk High |
| `frontend/src/api/client.ts` | `PROVEN`: defines the sole `VITE_API_BASE_URL` transport and direct `fetch` implementation | `ACCEPTED`: one Platform Gateway API base; internal module addresses and tokens prohibited | Path owner `ROLE-PLATFORM-FRONTEND`; `ROLE-PLATFORM-API` co-review; risk High |
| `frontend/src/api/generated/**` | `PROVEN`: generated-client placeholder only | Generated only from the aggregate public OpenAPI; no manual domain implementation | Path owner `ROLE-PLATFORM-FRONTEND`; source review by `ROLE-PLATFORM-CONTRACTS` |
| `frontend/src/data/mock-data.ts` | `PROVEN`: removed by `BL-AI-ARCH-007`; no shared cross-module mock remains | Must remain absent unless a later architecture decision defines a platform-owned read model fixture | Path owner `ROLE-PLATFORM-FRONTEND`; every represented module role co-reviews |
| `frontend/src/components/shared/**` | `PROVEN`: shared page header, status badge, and table toolbar presentation exist | Shared presentation only; no module business state | Path owner `ROLE-PLATFORM-FRONTEND`; affected module roles co-review |
| `frontend/src/components/ui/**` | `PROVEN`: shared UI primitives exist | Design-system primitives only | Exclusive path owner `ROLE-PLATFORM-FRONTEND` |
| `frontend/src/index.css` | `PROVEN`: shared stylesheet and currently modified | Shared CSS and design tokens only; joint visual review | Path owner `ROLE-PLATFORM-FRONTEND`; affected module roles co-review; risk High |
| `frontend/src/pages/module-page.tsx` | `PROVEN`: generic shared header/tab/content frame with no module-private state | Registration/composition only; module-private state stays in its feature path | Path owner `ROLE-PLATFORM-FRONTEND`; all affected module roles co-review; risk High |
| `frontend/src/pages/overview-page.tsx` | `PROVEN`: shared mock overview and currently modified | Read-only cross-module composition | Path owner `ROLE-PLATFORM-FRONTEND`; represented module roles co-review; risk High |
| `frontend/src/features/audit/**` | `PROVEN`: Audit registration, private mock, and page state are isolated here | Audit module-private UI only | Exclusive path owner `ROLE-AUDIT`; assignee `tianyulong23-dotcom`; risk Low |
| `frontend/src/features/keywords/**` | `PROVEN`: Keywords registration, private mock, and page state are isolated here | Keywords module-private UI only | Exclusive path owner `ROLE-KEYWORDS`; named human `UNKNOWN`; risk Low |
| `frontend/src/features/content/**` | `PROVEN`: Content registration, private mock, and page state are isolated here | Content module-private UI only | Exclusive path owner `ROLE-CONTENT`; named human `UNKNOWN`; risk Low |
| `frontend/src/features/projects/**` | `PROVEN`: website-project workspace is placed inside Backlinks navigation | `ACCEPTED`: remains in the Backlinks feature; it may consume but not define authoritative Platform Project Context | Exclusive path owner `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom`; risk Medium |
| `frontend/src/features/outreach/**` | `PROVEN`: Backlinks registration, private mocks/state, and Gateway client are isolated here | Backlinks module-private UI; shared transport changes occur outside this path | Exclusive path owner `ROLE-BACKLINKS`; assignee `tianyulong23-dotcom`; risk Low |
| `frontend/src/features/performance/**` | `PROVEN`: performance UI exists; product/data authority is not established | Keep isolated until product/data ownership is accepted | Exclusive path owner `ROLE-PERFORMANCE`; named human and domain owner `UNKNOWN`; risk High |

## Required Shared-Surface Review

| Shared surface | Current concrete paths | Accountable owner | Required co-review |
|---|---|---|---|
| App Shell and main routes | `frontend/src/App.tsx`; `frontend/src/app/**` | `ROLE-PLATFORM-FRONTEND` | Every module whose route, navigation, or rendering changes |
| Main navigation | `frontend/src/app/app-shell.tsx` | `ROLE-PLATFORM-FRONTEND` | `ROLE-PLATFORM-CONTEXT` plus every affected module |
| Project Context | The frontend prototype remains, while FastAPI now implements the signed `PlatformAccessToken.v1` verifier, read-only Project authority, and fail-closed `PlatformRequestContext.v1` resolver; production identity issuance remains `UNKNOWN` | `ROLE-PLATFORM-CONTEXT` | `ROLE-PLATFORM-FRONTEND`, `ROLE-PLATFORM-API`, and every consuming module |
| Public API base and transport | `frontend/src/api/client.ts`; `backend/api/**` | `ROLE-PLATFORM-API` | `ROLE-PLATFORM-FRONTEND` plus every affected domain role |
| Aggregate public OpenAPI | `backend/contracts/openapi/**`; future Gateway aggregation under `backend/api/**` | `ROLE-PLATFORM-CONTRACTS` | `ROLE-PLATFORM-API` plus every source module role |
| Backlinks module OpenAPI | `backend/contracts/openapi/backlinks.v1.json`; generator under `backend/core/**` | `ROLE-BACKLINKS` | `ROLE-PLATFORM-CONTRACTS` |
| Shared architecture | `docs/architecture/**` | `ROLE-ARCHITECTURE` | Every affected owner role |

### Equivalent Review Enforcement

`.github/CODEOWNERS` is not created by this task. The repository has no current
file, and the local GitHub CLI is not authenticated, so no enforceable GitHub
user/team mapping is claimed. The adopted repository-local equivalent review
record is `shared-surface-review-2026-07-24.md`.

Until the team adopts CODEOWNERS, the equivalent mandatory review record is a
pull-request review or a task/release record containing:

1. exact changed shared paths and affected modules;
2. approval from the accountable owner role and every required co-review role;
3. the confirmed human/team identity and approval date for each role;
4. conflict resolution evidence for pre-existing changes in the same path;
5. the relevant build, contract, and ownership checks.

Direct push is prohibited for a shared-surface change when any required role is
unstaffed or its approval evidence is absent. A future CODEOWNERS adoption must
map these exact role slots to confirmed GitHub users or teams and must not
weaken the multi-role rules above.

## Data Ownership

| Data group | Current repository fact | Write role | Cross-module access |
|---|---|---|---|
| Platform identity/project data | `PROVEN`: frozen Alembic revisions plus bridge place `projects` and `site_profiles` in `platform`; forced RLS and writer isolation pass on PostgreSQL 18.4 | `ACCEPTED`: schema `platform`; owner `growthos_platform_owner`; writer `growthos_platform_writer` | Versioned context/query only |
| Crawling evidence data | `PROVEN`: frozen Alembic revisions plus bridge place seven crawl/evidence tables in `crawling`; forced RLS and writer isolation pass on PostgreSQL 18.4 | `ACCEPTED`: schema `crawling`; owner `growthos_crawling_owner`; writer `growthos_crawling_writer` | Crawler writes evidence; Audit reads through the owned contract |
| Audit data | `PROVEN`: frozen Alembic revisions plus bridge place `audit_issues` and `pagespeed_results` in `audit`; forced RLS and writer isolation pass on PostgreSQL 18.4 | `ACCEPTED`: schema `audit`; owner `growthos_audit_owner`; writer `growthos_audit_writer` | Versioned command/query/event or read projection |
| Keywords data | `PROVEN`: no repository model/table migration identified; external state `UNKNOWN` | `ACCEPTED`: schema `keywords`; owner `growthos_keywords_owner`; writer `growthos_keywords_writer` | Versioned command/query/event or read projection |
| Content data | `PROVEN`: no repository model/table migration identified; external state `UNKNOWN` | `ACCEPTED`: schema `content`; owner `growthos_content_owner`; writer `growthos_content_writer` | Versioned command/query/event or read projection |
| Backlinks foundation/provider/recommendation/contact data | `PROVEN`: migrations `0001` through `0005` preserve and move 21 tables into `backlinks`; manifest checksums freeze the released chain | `ACCEPTED`: owner `growthos_backlinks_owner`; writer `growthos_backlinks_writer`; reporting `growthos_reporting_reader` is read-only | Gateway calls commands/queries; other modules use versioned contracts or read projections |
| Opportunity/Cycle/Cooperation/Placement/Monitoring data | `PROVEN`: migrations `0006` and `0007` add four Opportunity/Cycle/Cooperation/Counter tables, bringing Backlinks ownership to 25 forced-RLS tables; Placement/Monitoring remain future work | `ACCEPTED`: Backlinks Core/Worker only | Versioned contracts or read projections |
| Reporting projections | `UNKNOWN`: no backend projection table identified | `ACCEPTED`: schema `reporting`; owner `growthos_reporting_owner`; consumers use `growthos_reporting_reader` | Read-only to consumers |

The complete per-table ownership record and KEEP/ADAPT migration decision are
in `shared-database-ownership.md`. Repository SQL and disposable PostgreSQL
tests are `PROVEN`; application to local, staging, or production databases
remains `UNKNOWN`.

## Accepted Public HTTP Route Ownership

`Platform Gateway` means the FastAPI public process. `Backlinks Core` means the
private Fastify process. Exact quota values are implementation inputs, but
public rate-limit ownership is fixed here.

| Method/path | Public owner | Domain owner | Internal target | Permission | Rate limit | OpenAPI source | Deprecation |
|---|---|---|---|---|---|---|---|
| `GET /health` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Platform | Platform aggregate health | Public health policy | Gateway-owned | Platform aggregate | Gateway-managed; Backlinks private health is not a public alias |
| `GET /api/v1/projects/{websiteProjectKey}/backlinks/context` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Authenticated project membership; Backlinks rechecks ownership | Gateway-owned | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `GET /api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Authenticated project membership; Backlinks rechecks ownership | Gateway-owned | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `POST /api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates/{candidateId}/confirm` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Owner/Admin/Member plus Backlinks resource/version checks | Gateway-owned; no non-idempotent transport replay | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `GET /api/v1/projects/{websiteProjectKey}/backlinks/recommendations` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Authenticated project membership; Backlinks rechecks ownership | Gateway-owned | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `POST /api/v1/projects/{websiteProjectKey}/backlinks/recommendations/{recommendationId}/reject` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Owner/Admin/Member plus Backlinks resource/version/idempotency checks | Gateway-owned; idempotency key required | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `POST /api/v1/projects/{websiteProjectKey}/backlinks/recommendation-refill-jobs` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Owner/Admin/Member plus Backlinks resource/version/idempotency checks | Gateway-owned plus Backlinks budget/cost gates | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |
| `GET /api/v1/projects/{websiteProjectKey}/backlinks/summary` | `ACCEPTED`: Platform Gateway | `ACCEPTED`: Backlinks Core | Same method/path on private Backlinks service | Authenticated project membership; Backlinks rechecks ownership | Gateway-owned | Backlinks module contract, aggregated by Gateway | Versioned gateway policy; no parallel public alias |

The Backlinks `GET /health` registrar is `PROVEN` code and remains independently
documented as `backlinksPrivateHealthV1`. The public aggregate excludes it and
uses `platformHealthV1` for Platform `GET /health`. No browser may call the
Fastify address directly.

## Temporal Ownership

| Module | Current code/runtime fact | Task queue / workflow prefix | Worker owner |
|---|---|---|---|
| Audit | `PROVEN`: no module-specific Workflow or running poller found | `UNKNOWN` | `UNKNOWN` |
| Keywords | `PROVEN`: no module-specific Workflow or running poller found | `UNKNOWN` | `UNKNOWN` |
| Content | `PROVEN`: no module-specific Workflow or running poller found | `UNKNOWN` | `UNKNOWN` |
| Backlinks | `PROVEN`: two Workflow definitions, four Activity types, Outbox Relay, and a default-off Worker factory; disposable Temporal execution completed through an injected failure and Worker restart; persistent deployment remains `UNKNOWN` | Queue `growthos.backlinks.v1`; Workflow types `backlinksProjectAnalysisV1Workflow` and `backlinksRecommendationRefillV1Workflow`; IDs `backlinks:<workspaceId>:<websiteProjectId>:<workflow-kind>:v1:<instanceId>` | `ROLE-BACKLINKS`; repository assignee `tianyulong23-dotcom`; deployment owner remains `UNKNOWN` |

## Event And Contract Ownership

| Contract | Composition owner | Fact/source owner | Rule |
|---|---|---|---|
| Public aggregate OpenAPI | `ROLE-PLATFORM-CONTRACTS` | Platform owns `GET /health`; `ROLE-BACKLINKS` owns the retained Backlinks module contract | Duplicate method/path, `operationId`, component, or schema is rejected; private module paths are excluded explicitly |
| `backlinks.project-analysis.requested.v1` | `ROLE-BACKLINKS` Outbox Relay | `ROLE-BACKLINKS` | Module-internal, payload version 1, dedupe by Workflow ID |
| Cross-module events | `ROLE-PLATFORM-CONTRACTS` registry plus producer/consumer review | Producing module owns the fact and Outbox | Current list is empty; a future consumer may write only its own projection |
| Temporal runtime registry | `ROLE-PLATFORM-CONTRACTS` | Each module owns its queue, Workflow/Activity types, Worker permissions, and Provider Kill Switch | Shared or unprefixed identifiers fail the registry gate |

The Backlinks Provider Kill Switch is `backlinks.dataforseo.v1`. It remains
inside the Backlinks quota, budget, cache, and usage-ledger policy; no Platform,
Audit, Keywords, or Content module may toggle it as its own switch.

## Merge Rules

1. A product fact has one write owner.
2. A public method/path has one public owner and one domain owner.
3. An exclusive path has exactly one accountable owner role.
4. Shared registration, composition, context, transport, and contract paths
   require their accountable owner plus every affected module owner.
5. Module-private changes should not modify shared files unless registration is required.
6. Cross-module integration uses contracts, events, or read projections.
7. No module reads another module's production credentials.
8. Git authorship is not owner acceptance.
9. No commit or push is implied by updating this document.
10. The Platform Gateway may proxy Backlinks routes but may not execute
    Backlinks state transitions or SQL.
11. The private Backlinks service may not expose a browser/public API base.
12. One method/path cannot have a second public backend implementation.
13. An `UNKNOWN` named human blocks approval; an Owner role label alone is not
    approval evidence.
14. `backend/core/**` is Backlinks-exclusive and cannot host another module.
15. `backend/services/backlinks-core/**` cannot become a parallel copy.
16. Shared files cannot be resolved by overwriting another contributor's work.

## Required Follow-up

- `PROVEN`: `BL-AI-ARCH-001` completed the repository/runtime fact inventory.
- `ACCEPTED`: `BL-AI-ARCH-002` selects FastAPI as the only public Platform
  Gateway and Fastify Backlinks Core as a cross-process private service.
- `ACCEPTED`: `BL-AI-ARCH-003` retains `backend/core/**` as the
  Backlinks-exclusive path, assigns role-level owners, and establishes the
  equivalent shared-file review rules above.
- `PROVEN`: `BL-AI-ARCH-008-FU-001` staffs every role required by the approved
  follow-up path set and records role, path, approval date, conflict handling,
  and verification evidence in `shared-surface-review-2026-07-24.md`.
- `PROVEN`: `BL-AI-ARCH-008-FU-002` adds a loopback-default private Fastify
  bootstrap that reuses all eight Backlinks route registrars, adds no browser
  CORS or public API base, and supports graceful start/stop.
- `PROVEN`: `BL-AI-ARCH-008-FU-003` adds exactly seven FastAPI Gateway
  adapters. They resolve and sign Platform context, enforce project binding,
  forward once, require idempotency for reject/refill, map transport failure
  to the agreed unavailable problem, and perform no Backlinks SQL.
- `PROVEN`: `BL-AI-ARCH-008-FU-004` adds a disposable cross-process isolation
  gate. After Backlinks stops, Platform health and a test-only Audit probe
  remain available while Backlinks returns exact `503 BACKLINKS_UNAVAILABLE`.
- `PROVEN`: `BL-AI-ARCH-004` implements `PlatformRequestContext.v1` through
  the shared JSON Schema under `backend/contracts/**`, the Platform Gateway
  producer under `backend/api/**`, and the Backlinks consumer under
  `backend/core/**`.
- `PROVEN`: the Gateway strips browser-supplied internal context headers and
  signs only resolved Actor, Tenant, Project, Permission, and Correlation
  facts. Backlinks verifies integrity, issuer, audience, lifetime, strict
  shape, and URL project binding before exposing the context to handlers.
  Dual-ended tests cover a Python-produced cross-language vector plus missing,
  tampered, expired, wrong-audience, and cross-project inputs. Existing
  resource ownership, role, RLS, and ExpectedVersion controls remain
  authoritative.
- `PROVEN`: `BL-AI-ARCH-005` established the original six-schema matrix,
  hardened privilege roles, Backlinks `0005` ownership adaptation, per-table
  ownership, and disposable PostgreSQL permission tests. `SEO4-INT-004`
  extends that matrix with the separate `crawling` schema and PostgreSQL 18
  dual-migration evidence. Gateway has no business grant, cross-schema writes
  are denied, reporting is read-only, and published Backlinks migrations
  retain their recorded SHA-256 hashes.
- `UNKNOWN`: deployment login principals, production application, production
  backup schedule, RTO/RPO, and environment-specific restore approval remain
  operations gates. Repository-level disposable restore evidence is `PROVEN`.
- `PROVEN`: `BL-AI-ARCH-006` enforces aggregate OpenAPI method/path,
  `operationId`, component, and schema uniqueness while retaining the module
  contract and separating private Backlinks health from public Platform health.
- `PROVEN`: the Backlinks event, Task Queue, Workflow ID/type, Activity type,
  Worker database permission, and Provider Kill Switch namespaces pass
  repository and disposable-runtime gates. Deployed Temporal state and named
  deployment owners remain `UNKNOWN`.
- `PROVEN`: `BL-AI-ARCH-007` establishes one frontend module registration
  contract and registry, separates Audit/Keywords/Content/Backlinks routes,
  state, mocks, and the Backlinks Gateway client into module feature paths,
  and leaves the shared shell as registration and presentation composition.
- `PROVEN`: the existing navigation order is preserved, Website Projects
  remains inside Backlinks, the browser has one Platform Gateway API base, and
  desktop/mobile acceptance at port 4174 has no horizontal overflow.

## SEO4-INT-001 Ownership And Review Addendum

> Snapshot date: `2026-07-24`
> Baseline: `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`

The fetched commit is authored and committed by the GitHub identity
`john3947`. This is `PROVEN` authorship evidence only. The remote tree has no
`.github/CODEOWNERS`, so authorship does not establish exclusive ownership or
merge approval for Platform, Project, Audit, Crawler, database, Temporal,
Compose, contracts, or frontend paths.

The existing repository-local review record continues to assign
`tianyulong23-dotcom` to `ROLE-PLATFORM-API`, `ROLE-PLATFORM-CONTEXT`,
`ROLE-PLATFORM-CONTRACTS`, `ROLE-PLATFORM-FRONTEND`, `ROLE-BACKLINKS`,
`ROLE-ARCHITECTURE`, and `ROLE-AUDIT`. That approval covers the exact prior
recorded paths and is not independent review of the fetched coworker commit.

| Surface | Current author/owner evidence | Required integration review | Status |
|---|---|---|---|
| FastAPI, Project, and Audit implementation | `PROVEN`: remote commit author `john3947`; exclusive owner not declared | `ROLE-PLATFORM-API`, `ROLE-PLATFORM-CONTEXT`, and `ROLE-AUDIT`; remote owner confirmation required before overwrite or merge | `BLOCKED` for merge |
| Go Crawler and crawler contracts | `PROVEN`: remote commit author `john3947`; `ROLE-CRAWLER` named human remains `UNKNOWN` | Staff `ROLE-CRAWLER`, plus Platform/Audit reviewers for task and write contracts | `BLOCKED` for merge |
| Alembic, PostgreSQL 18, and Compose | `PROVEN`: the frozen Alembic chain, ownership bridge, checksummed dual-migration manifest, and disposable PostgreSQL 18.4 clean/upgrade/restore evidence exist; `ROLE-PLATFORM-DATABASE-OPERATIONS` remains `UNKNOWN` | Staff database operations owner and obtain production promotion/restore approval | `BLOCKED` for production merge/promotion |
| Shared frontend | `PROVEN`: remote and local work overlap in shared route/shell files | `ROLE-PLATFORM-FRONTEND` plus Project, Audit, and Backlinks affected roles | `BLOCKED` pending path-level plan |
| Backlinks Core and local Gateway adapters | `PROVEN`: local untracked/dirty implementation; not present in the fetched remote commit | `ROLE-BACKLINKS`, Platform API/Context/Contracts, and Architecture | Protected local input |
| Remote repository approval | `PROVEN`: no CODEOWNERS; authenticated repository administrator/reviewer not established | Exact remote owner or reviewer identity | `UNKNOWN` |

### Non-Overwrite Rule

The following exact dirty paths are changed by both the local checkout and the
fetched remote commit and cannot be resolved by whole-file overwrite:

- `backend/api/.env.example`
- `backend/api/app/api/router.py`
- `backend/api/app/core/config.py`
- `backend/api/app/main.py`
- `backend/api/pyproject.toml`
- `backend/api/uv.lock`
- `backend/contracts/temporal/README.md`
- `frontend/src/App.tsx`
- `frontend/src/app/app-shell.tsx`
- `frontend/src/components/agent/agent-dock.tsx`
- `frontend/src/components/shared/page-header.tsx`
- `frontend/src/data/mock-data.ts`
- `frontend/src/pages/module-page.tsx`
- `frontend/src/pages/overview-page.tsx`

In addition, no future integration may discard either of these ownership
inputs:

1. The remote committed Project/Audit/Crawler/Alembic/Compose/frontend
   implementation at `8261ea91`.
2. The local Backlinks Core, Gateway adapters, governance documents, shared
   contracts, database bootstrap, and module-registration work.

`SEO4-INT-002` must classify each overlapping path and duplicated capability
before any merge, pull, rebase, checkout, replacement, or shared-file edit.

## SEO4-INT-003 Project, Auth, And Context Addendum

> Snapshot date: `2026-07-24`

- `PROVEN`: the coworker `Project` and `SiteProfile` ORM file is retained
  byte-for-byte from `origin/main@8261ea91`.
- `PROVEN`: FastAPI has a read-only `projects.id` authority and no second
  Project CRUD or Project write path.
- `PROVEN`: `PlatformAccessToken.v1` cryptographically binds Actor, session,
  organization, workspace, roles, Project grants, permissions, issuer,
  audience, issued-at, and expiry.
- `PROVEN`: the resolver rejects forged/expired tokens, cross-tenant,
  cross-workspace, cross-project, and insufficient-permission access.
- `PROVEN`: browser internal-context headers do not become authority. FastAPI
  produces the existing signed internal context and Backlinks Core retains its
  fail-closed consumer.
- `PROVEN`: default configuration returns the rejecting resolver unless both
  auth verification and internal context signing keys are configured.
- `UNKNOWN`: production identity issuance, revocation, key rotation, secret
  provisioning, and live Project migration state.

Required repository-local review is triggered for `ROLE-PLATFORM-API`,
`ROLE-PLATFORM-CONTEXT`, `ROLE-PLATFORM-CONTRACTS`, and the consuming
`ROLE-BACKLINKS`. Authenticated external GitHub approval remains `UNKNOWN`.

## SEO4-INT-004 Database Ownership Addendum

> Snapshot date: `2026-07-24`

- `PROVEN`: six source Alembic revisions remain byte-for-byte equal to
  `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`.
- `PROVEN`: one forward-only Alembic bridge separates two Platform tables,
  seven Crawling evidence tables, and two Audit conclusion tables.
- `PROVEN`: Backlinks SQL remains the sole migration authority for 25
  Backlinks tables; released migrations retain their recorded checksums.
- `PROVEN`: the shared bootstrap declares seven schemas and 15 hardened roles.
  Crawling may read Platform facts and write Crawling evidence; Audit may read
  Crawling evidence and write Audit conclusions; cross-schema writes fail.
- `PROVEN`: the checksummed deployment manifest fixes both migration heads,
  order, prerequisites, owner, schema, and restore-or-forward-only recovery.
- `PROVEN`: PostgreSQL 18.4 clean install, existing upgrade with seeded data,
  custom-format backup/restore, RLS, ownership, and permission gates pass.
- `UNKNOWN`: production principals, environment migration application,
  production RTO/RPO approval, and authenticated Database Operations/Crawler
  owner approval.

## SEO4-INT-005 Contract Ownership Addendum

> Snapshot date: `2026-07-24`

- `PROVEN`: `ROLE-PLATFORM-CONTRACTS` composes the checked public OpenAPI but
  does not take ownership of Project, Audit, or Backlinks operations.
- `PROVEN`: Project operations retain Platform ownership, Audit operations
  retain Audit ownership, and Backlinks operations retain Backlinks ownership.
- `PROVEN`: Crawling owns `crawling.evidence.requested.v1`,
  `crawling.evidence.recorded.v1`, and `crawler.evidence.v1`.
- `PROVEN`: Crawling may publish observations and artifact references only.
  Platform, Audit, and Backlinks are the sole writers of their final facts.
- `PROVEN`: the registry reserves independent queues for Platform, Audit,
  Crawling, and Backlinks. The later `SEO4-INT-004` database contract grants
  the Crawling writer only its owned evidence schema and read-only Platform
  Project access.
- `PROVEN`: Provider Kill Switch ownership is Platform for Business Profile AI,
  Audit for Google PageSpeed, and Backlinks for DataForSEO.
- `UNKNOWN`: the target Platform, Audit, and Crawling Workers are not yet
  executable under the new identifiers, and the source Go worker still needs
  its evidence adapter and write-boundary correction.

Both sides' required review scopes are triggered:

| Changed surface | Path/composition owner review | Affected source/module owner review | Approval status |
|---|---|---|---|
| Aggregate OpenAPI | `ROLE-PLATFORM-CONTRACTS`, `ROLE-PLATFORM-API` | `ROLE-AUDIT`, `ROLE-BACKLINKS`, remote Project/Audit owner | Repository-local scopes recorded; authenticated remote approval `UNKNOWN` |
| Events, Temporal, crawler evidence | `ROLE-PLATFORM-CONTRACTS` | `ROLE-CRAWLER`, `ROLE-AUDIT`, `ROLE-BACKLINKS`, Platform owner | Review scopes recorded; `ROLE-CRAWLER` staffing and authenticated remote approval `UNKNOWN` |

The review trigger is not approval to merge or overwrite the source repository.
