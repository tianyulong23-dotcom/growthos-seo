# Shared Backend Inventory

> Task: `BL-AI-ARCH-001`
> Snapshot date: `2026-07-23`
> Scope: repository and local runtime inventory only
> Repository ownership updates: through `BL-AI-ARCH-007`

This inventory records observed facts separately from architectural targets.
It does not accept the deployment topology, assign a human owner, apply a
migration, or prove that a repository migration is installed in the local
database.

## Evidence Labels

| Label | Meaning |
|---|---|
| `PROVEN` | Confirmed by an inspected file, command, port, HTTP result, browser request, or existing test evidence |
| `DECLARED` | Stated by an external document or operator but not yet verified against repository or runtime evidence |
| `INFERRED` | Likely from repository structure, but not directly confirmed |
| `UNKNOWN` | Not established by the current repository and runtime evidence |

## Repository And Git Topology

| Inventory item | Label | Evidence |
|---|---|---|
| Outer workspace Git root | `PROVEN` | `git -C C:\Users\DELL\Documents\缝合 rev-parse --show-toplevel` returned `C:/Users/DELL/Documents/缝合`; branch `codex/pre-code-final-validation`, HEAD `5c69d22`, 15 dirty status entries before this task's documentation edits |
| Product repository Git root | `PROVEN` | `git rev-parse --show-toplevel` inside `john3947-seo` returned `C:/Users/DELL/Documents/缝合/john3947-seo`; branch `main`, HEAD `a9380e7`, 17 dirty status entries before this task's documentation edits |
| Nested repository relationship | `PROVEN` | The outer repository reports `?? john3947-seo/`; the product repository has its own `.git` root |
| Backlinks implementation tracking | `PROVEN` | The product repository reports `?? backend/core/`; `git ls-files` has no tracked `backend/core/**` files at HEAD |
| Shared architecture tracking | `PROVEN` | The product repository reports `?? docs/architecture/`; the generated `backend/contracts/openapi/backlinks.v1.json` is also untracked |
| Existing shared frontend changes | `PROVEN` | `git status --short` reports modified `App.tsx`, `app-shell.tsx`, `api/client.ts`, `mock-data.ts`, `index.css`, `module-page.tsx`, and `overview-page.tsx` |
| Repository owner declaration | `PROVEN` | `.github/CODEOWNERS` does not exist |
| Named Platform, Audit, Keywords, Content, Backlinks, database, workflow, and shared-frontend owners | `UNKNOWN` | No accepted owner registry or named maintainer record was found; Git authorship is not treated as ownership |

## Backend Directories And Entrypoints

| Directory | Current entrypoint or composition surface | Label | Evidence |
|---|---|---|---|
| `backend/api/` | FastAPI application at `app/main.py`; documented launch command `uv run uvicorn app.main:app --reload` | `PROVEN` | `app/main.py` creates the app and includes `app/api/router.py`; the router registers only `GET /health` |
| `backend/api/app/modules/audit/` | Placeholder package only | `PROVEN` | The only file is `__init__.py` |
| `backend/api/app/modules/keywords/` | Placeholder package only | `PROVEN` | The only file is `__init__.py` |
| `backend/api/app/modules/content/` | Placeholder package only | `PROVEN` | The only file is `__init__.py` |
| `backend/core/` | TypeScript/Fastify Backlinks package with route registrars, repositories, migrations, workflows, and tests | `PROVEN` | `package.json` names `@growthos/backlinks-core`; `src/modules/backlinks/**` contains the implementation |
| `backend/core/` standalone service entrypoint | No runnable API or Worker bootstrap was found | `PROVEN` | `src/index.ts` is `export {};`; `package.json` has no `start`, `dev`, or server script; no source call to `listen()` was found |
| `backend/workers/` | Python CLI registry | `PROVEN` | `python -m seo_workers --list` is documented; `__main__.py` only lists `analysis`, `ai`, `integration`, and `publish` and does not start a Worker |
| `backend/crawler/` | Go process at `cmd/crawler/main.go` | `PROVEN` | `worker.Run` logs start, waits for cancellation, and logs stop; no crawl transport or business write is implemented |
| `backend/browser-worker/` | TypeScript capability module | `PROVEN` | `src/worker.ts` exports `render-page`, `capture-dom`, and `capture-screenshot`; `package.json` has no Worker start script |
| `backend/contracts/` | Cross-language contract directories plus generated Backlinks OpenAPI | `PROVEN` | Temporal, event, and JSON Schema READMEs are placeholders; `openapi/backlinks.v1.json` contains the current Backlinks HTTP contract |
| `backend/database/` | Shared PostgreSQL role/schema bootstrap | `PROVEN` | `roles/0001_growthos_schema_roles.sql` declares hardened module privilege roles and six empty owned schemas without business tables or credentials |
| Public Platform Gateway implementation | `UNKNOWN` | No accepted gateway bootstrap or running gateway was found; the FastAPI skeleton and Backlinks registrars are not proof of the final public topology |

## Local Runtime Snapshot

| Endpoint or process | Label | Observed result |
|---|---|---|
| Frontend `127.0.0.1:4174` | `PROVEN` | PID `21288` runs Vite from `frontend/node_modules`; `GET /` returned HTTP `200` with `text/html` |
| FastAPI/default API `127.0.0.1:8000` | `PROVEN` | No listener; both `http://127.0.0.1:8000/health` and `http://localhost:8000/health` refused the connection |
| PostgreSQL `127.0.0.1:5432` | `PROVEN` | Windows service `postgresql-x64-17` is Running/Automatic; `pg_isready` reported accepting connections; `psql --version` reported PostgreSQL `17.10` |
| Temporal `127.0.0.1:7233` | `PROVEN` | No listening socket was found |
| Redis `127.0.0.1:6379` | `PROVEN` | No listening socket was found |
| Running Backlinks Fastify API | `PROVEN` | No matching listener or runnable service process was found |
| Running Backlinks Temporal Worker | `PROVEN` | No matching Worker process or Temporal listener was found |
| Local PostgreSQL schemas, applied migrations, and module roles | `UNKNOWN` | This inventory used non-mutating service/readiness checks only and did not authenticate to enumerate database objects |

## Frontend Requests At `127.0.0.1:4174`

Playwright used the installed Chrome channel and observed fetch/XHR traffic after
loading each route.

| Frontend route | Label | Actual request evidence |
|---|---|---|
| `/projects/elephtv/audit/overview` | `PROVEN` | No fetch or XHR request was emitted; the page renders repository mock data |
| `/projects/elephtv/keywords/library` | `PROVEN` | No fetch or XHR request was emitted; the page renders repository mock data |
| `/projects/elephtv/content/opportunities` | `PROVEN` | No fetch or XHR request was emitted; the page renders repository mock data |
| `/projects/elephtv/backlinks/opportunities` | `PROVEN` | Two development-mode `GET http://localhost:8000/health` requests were emitted and both failed with `net::ERR_CONNECTION_REFUSED`; no Backlinks business endpoint was requested |
| Browser-visible module completion | `UNKNOWN` | The current UI content cannot prove Audit, Keywords, Content, or Backlinks backend completion |

## Module Reality

| Module | Route evidence | Database evidence | Worker evidence | Current owner |
|---|---|---|---|---|
| Platform | `PROVEN`: FastAPI exposes only `GET /health`; final gateway routes are absent | `PROVEN`: FastAPI Alembic versions contain only `.gitkeep`; `UNKNOWN`: external/platform database state | `PROVEN`: only generic clients/skeletons exist; `UNKNOWN`: platform task queues | `UNKNOWN` |
| Audit | `PROVEN`: no Audit route exists in FastAPI or the inspected OpenAPI; frontend sends no API request | `PROVEN`: no Audit migration/model was found in the inspected repository; `UNKNOWN`: external database state | `PROVEN`: no Audit-specific Worker implementation was found; the generic `analysis` registry name does not prove ownership | `UNKNOWN` |
| Keywords | `PROVEN`: no Keywords route exists in FastAPI or the inspected OpenAPI; frontend sends no API request | `PROVEN`: no Keywords migration/model was found in the inspected repository; `UNKNOWN`: external database state | `PROVEN`: no Keywords-specific Worker implementation was found | `UNKNOWN` |
| Content | `PROVEN`: no Content route exists in FastAPI or the inspected OpenAPI; frontend sends no API request | `PROVEN`: no Content migration/model was found in the inspected repository; `UNKNOWN`: external database state | `PROVEN`: no Content-specific Worker implementation was found; generic `ai` and `publish` names do not prove Content ownership | `UNKNOWN` |
| Backlinks | `PROVEN`: Fastify registrars and an eight-operation module OpenAPI contract exist; the public aggregate retains seven Backlinks operations and excludes private Backlinks health; `PROVEN`: no Backlinks API is running | `PROVEN`: four published SQL migrations define 21 forced-RLS tables and `0005` adapts them to the `backlinks` schema/roles; disposable PostgreSQL permissions pass; `UNKNOWN`: production application | `PROVEN`: two namespaced Workflow definitions, four namespaced Activity types, a default-off Worker factory, and an Outbox Relay exist; disposable Temporal execution used the registered queue and identifiers; `PROVEN`: no persistent Worker is running; `UNKNOWN`: deployed runtime state | `UNKNOWN` human owner; repository code establishes the current domain implementation |

## Backlinks HTTP Contract

All entries below are `PROVEN` from
`backend/contracts/openapi/backlinks.v1.json`; they are contract/code evidence,
not evidence of a listening service.

| Method | Path | Label |
|---|---|---|
| `GET` | `/health` | `PROVEN` |
| `GET` | `/api/v1/projects/{websiteProjectKey}/backlinks/context` | `PROVEN` |
| `GET` | `/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates` | `PROVEN` |
| `POST` | `/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates/{candidateId}/confirm` | `PROVEN` |
| `GET` | `/api/v1/projects/{websiteProjectKey}/backlinks/recommendations` | `PROVEN` |
| `POST` | `/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/{recommendationId}/reject` | `PROVEN` |
| `POST` | `/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-refill-jobs` | `PROVEN` |
| `GET` | `/api/v1/projects/{websiteProjectKey}/backlinks/summary` | `PROVEN` |

The independently retained module contract has eight unique `operationId`
values. The generated public aggregate at
`backend/contracts/openapi/platform.v1.json` also has eight method/path pairs:
Platform `GET /health` plus the seven public Backlinks operations. Duplicate
method/path, `operationId`, component, and schema fixtures fail closed.

## Backlinks Database Inventory

| Migration | Label | Tables |
|---|---|---|
| `0001_backlink_foundation.sql` | `PROVEN` | `backlink_idempotency_records`, `backlink_outbox_events`, `backlink_jobs`, `backlink_lifecycle_events`, `backlink_audit_events`, `backlink_project_context_snapshots` |
| `0002_backlink_provider_seo.sql` | `PROVEN` | `backlink_provider_requests`, `backlink_seo_snapshots`, `backlink_provider_cache_entries`, `backlink_provider_budgets`, `backlink_provider_usage_ledger` |
| `0003_backlink_recommendations.sql` | `PROVEN` | `backlink_prospects`, `backlink_recommendations`, `backlink_recommendation_scores`, `backlink_recommendation_inventory`, `backlink_recommendation_claims`, `backlink_recommendation_rejections`, `backlink_recommendation_refills` |
| `0004_backlink_contacts_opportunities.sql` | `PROVEN` | `backlink_contact_candidates`, `backlink_contact_evidence`, `backlink_contacts`; despite the filename, no Opportunity table is present |
| `0005_backlink_schema_role_ownership.sql` | `PROVEN` | Forward-only compatibility migration moves all 21 tables and three functions to `backlinks`, transfers owner, and applies writer/reporting grants |
| Module schema and database role names | `ACCEPTED` / `PROVEN` repository contract | Shared bootstrap fixes `platform`, `audit`, `keywords`, `content`, `backlinks`, and `reporting`; the Backlinks owner/writer and Gateway/reporting restrictions pass in disposable PostgreSQL |
| Opportunity, Cycle, Cooperation, Placement, and Monitoring persistence | `PROVEN` absent from current migrations | These facts remain outside the implemented table inventory and must not be inferred from frontend mock labels or generic lifecycle test fixtures |

## Temporal And Worker Inventory

| Item | Label | Evidence |
|---|---|---|
| Backlinks Worker enablement | `PROVEN` | `BACKLINKS_WORKER_ENABLED` defaults to false and must be true before `startBacklinksWorker` can run |
| Backlinks queue configuration | `PROVEN` repository and disposable runtime / `UNKNOWN` deployment | The only registered queue is `growthos.backlinks.v1`; the Worker/client reject a different value; no deployed value or active persistent poller was inspected |
| Backlinks Workflow definitions | `PROVEN` | `backlinksProjectAnalysisV1Workflow` and `backlinksRecommendationRefillV1Workflow` are exported and registered |
| Backlinks workflow ID naming | `PROVEN` | `backlinks:<workspaceId>:<websiteProjectId>:<workflow-kind>:v1:<instanceId>` is built and validated for `project-analysis` and `recommendation-refill` |
| Backlinks Activity type naming | `PROVEN` | Four registered Activity types are prefixed with `backlinks` and suffixed with `V1` |
| Backlinks event naming | `PROVEN` | `backlinks.project-analysis.requested.v1` is module-internal; the cross-module event list is empty |
| Backlinks Worker/provider boundary | `PROVEN` repository / `UNKNOWN` deployment | Worker role is `growthos_backlinks_writer`, allowed schema is only `backlinks`, and DataForSEO Kill Switch is `backlinks.dataforseo.v1` |
| Audit, Keywords, and Content queues/workflows | `UNKNOWN` | No module-specific implementation or runtime poller was found |
| Generic Python, Go, and Browser workers as module owners | `UNKNOWN` | Their directory names and capability labels do not establish product fact ownership |

## Shared Hotspots

| Hotspot | Label | Current evidence |
|---|---|---|
| `frontend/src/App.tsx` and `frontend/src/app/app-shell.tsx` | `PROVEN` | Shared route/navigation files are already modified; named review owner is `UNKNOWN` |
| `frontend/src/api/client.ts` | `PROVEN` | Shared transport defaults to `http://localhost:8000`; the active page uses it only for `/health`; final gateway base and owner are `UNKNOWN` |
| `frontend/src/app/module-registry.ts`, `module-contract.ts`, and `platform-navigation.ts` | `PROVEN` | One Platform-owned registration and navigation composition surface exists for Audit, Keywords, Content, and Backlinks |
| `frontend/src/data/mock-data.ts` | `PROVEN` | Removed by `BL-AI-ARCH-007`; module mocks now live under their owning feature paths |
| `frontend/src/pages/module-page.tsx`, `overview-page.tsx`, and `index.css` | `PROVEN` | Shared presentation files are modified; `module-page.tsx` now contains no module-private state; named review owners are `UNKNOWN` |
| `backend/contracts/openapi/backlinks.v1.json` and `platform.v1.json` | `PROVEN` | The Backlinks module contract is retained independently; the Platform aggregate is generated with uniqueness checks and excludes private Backlinks health |
| `backend/contracts/events/registry.v1.json` and `temporal/registry.v1.json` | `PROVEN` | Module event, Task Queue, Workflow, Activity, Worker permission, and Provider Kill Switch namespaces are machine-checked |
| `docs/architecture/**` | `PROVEN` | Shared architecture documents exist in an untracked directory; accepted reviewers are `UNKNOWN` |
| `backend/core/**` | `PROVEN` / `ACCEPTED` | Current Backlinks implementation path exists and is untracked; `BL-AI-ARCH-003` retains it as the exclusive Backlinks path |

## Unresolved Items

| Item | Label |
|---|---|
| Human owners and reviewers for Platform, Audit, Keywords, Content, Backlinks, database, Temporal, contracts, and shared frontend paths | `UNKNOWN` |
| Deployment of the accepted FastAPI public Gateway and private Fastify Backlinks topology | `UNKNOWN` runtime state |
| Deployment of the accepted public Backlinks route ownership/proxy policy | `UNKNOWN` runtime state |
| Actual local/production schema and migration application state, deployment login-role memberships, backup schedule, RTO/RPO, and restore-drill evidence | `UNKNOWN` |
| Deployed Temporal namespace, active Backlinks queue/history, Worker deployment owner, and all Audit/Keywords/Content runtime contracts | `UNKNOWN` |
| Whether Audit, Keywords, or Content implementations exist outside the inspected repository | `UNKNOWN` |

## ARCH-007 Frontend Registration Update

| Item | Label | Evidence |
|---|---|---|
| Shared module contract | `PROVEN` | `frontend/src/app/module-contract.ts` defines the accepted registration fields and four module IDs |
| Shared registry | `PROVEN` | `frontend/src/app/module-registry.ts` composes four registrations; `App.tsx` consumes routes and the App Shell consumes navigation |
| Module-private boundaries | `PROVEN` | Audit, Keywords, Content, and Backlinks each own registration, page implementation, and mock data under `frontend/src/features/**` |
| Single browser API base | `PROVEN` | `frontend/src/api/client.ts` contains the only direct `fetch` and reads the only `VITE_API_BASE_URL`; Backlinks delegates through it |
| Website Projects placement | `PROVEN` | `/projects/:projectId/backlinks/projects` remains the first Backlinks tab and has no separate main-navigation entry |
| Browser acceptance | `PROVEN` | Audit, Keywords, Content, Backlinks, Performance, and Settings routes rendered at 1440x900; all four registered modules rendered at 390x844; all checked pages had no horizontal overflow |
| Gateway runtime | `PROVEN` unavailable locally | The frontend remained HTTP 200 on port 4174; two handled `/health` requests were refused because port 8000 had no listener |

## Commands And Checks

The following evidence-producing checks were run without modifying business
code or database state:

- `PROVEN`: `git status --short --branch`, `git rev-parse --show-toplevel`,
  `git log -1`, and `git ls-files` in both Git roots.
- `PROVEN`: scoped `Get-ChildItem`, `Get-Content`, `Select-String`, and `rg`
  inspection of backend entrypoints, routes, migrations, Workers, contracts,
  frontend routing, and API calls.
- `PROVEN`: `Get-NetTCPConnection`, `Get-CimInstance Win32_Process`,
  `Get-Service`, PostgreSQL `pg_isready`, and `psql --version`.
- `PROVEN`: `Invoke-WebRequest` against ports `4174` and `8000`.
- `PROVEN`: Playwright navigation to Audit, Keywords, Content, and Backlinks
  routes with fetch/XHR and request-failure capture.
- `PROVEN`: shared contract generation/checking, OpenAPI conflict tests, event
  and Temporal registry tests, full TypeScript verification, Python
  `pytest`/Ruff, and a disposable Temporal Worker restart test.

## Task Boundary

- `PROVEN`: no business code, migration, configuration, dependency, or frontend
  file was changed by `BL-AI-ARCH-001`.
- `PROVEN`: no authenticated database query, production service call, paid
  provider call, Git commit, or Git push was performed.
- `PROVEN`: `BL-AI-ARCH-002`, `BL-AI-074`, and later tasks were not executed.

## SEO4-INT-001 GitHub Baseline Addendum

> Task: `SEO4-INT-001`
> Snapshot date: `2026-07-24`
> Result: `DONE`

This addendum preserves the earlier local snapshot and freezes the coworker
baseline from the readable Git remote. The operator clarified that
`E:\seo-v4` was only a coworker-machine path label. The accepted source for
this inventory is the `john3947/seo` GitHub repository exposed locally as
`origin`; no local `E:` drive is required.

### Repository Baselines

| Side | Root or source | Branch/ref | HEAD | Status | Label |
|---|---|---|---|---|---|
| Outer planning workspace | `C:\Users\DELL\Documents\缝合` | `codex/pre-code-final-validation` | `5c69d2254c9acb5564781b847f8a8ab0de5c7385` | 4 tracked dirty files and 18 untracked entries; no Git remote configured | `PROVEN` |
| Local product checkout | `C:\Users\DELL\Documents\缝合\john3947-seo` | `main` | `a9380e70a571b722f0ffdbfdb7b0adfc318faee4` | 19 tracked modified/deleted files and 255 untracked files | `PROVEN` |
| Coworker Git baseline | `https://github.com/john3947/seo.git` through local `origin` | `origin/main` | `8261ea91a881948e3982a0eb96383c4c8bfa2523` | Immutable fetched commit; local `main` is 0 ahead and 1 behind | `PROVEN` |

`git fetch --prune origin` completed successfully. No pull, checkout, merge,
rebase, commit, or push was performed. The remote commit is authored and
committed by `john3947` at `2026-07-23T16:36:37+08:00` with subject
`feat: implement project onboarding and site audit workflow`. Authorship is
not treated as module ownership.

The fetched tree contains 225 files. Relative to the local HEAD, the remote
commit changes 143 files with 37,790 insertions and 1,310 deletions.

### Remote Stack And Service Inventory

| Surface | Remote baseline | Label |
|---|---|---|
| Frontend | React 19, TypeScript 6, Vite 8, React Router 8, Tailwind 4, Shadcn UI; routes `/projects` and `/projects/:projectId/**`; one API base defaults to `http://localhost:8000` | `PROVEN` |
| Platform API | Python 3.13, FastAPI, SQLAlchemy async, Alembic, asyncpg, Redis client, Temporal SDK, boto3, Uvicorn | `PROVEN` |
| Project context | `projects` and `site_profiles` models use `organization_id` and `project_id`; configuration supplies `default_organization_id = "local"` | `PROVEN` |
| Authentication and membership | No authentication, membership, tenant-authority route, model, migration, or dependency was found in the fetched tree | `PROVEN` absent; production authority `UNKNOWN` |
| Crawler | Go 1.25.4, Colly, Rod/Chromium, pgx, AWS S3 SDK, Temporal Go SDK | `PROVEN` |
| Shared runtime | PostgreSQL 18, Redis 7, MinIO, Temporal, FastAPI, Go crawler worker, and frontend are declared in Compose | `PROVEN` repository definition |
| Browser worker | The remote commit removes the earlier `backend/browser-worker/**` package | `PROVEN` |

### Public Route Inventory

The fetched FastAPI router registers 27 operations:

| Route group | Operations | Label |
|---|---|---|
| System | `GET /health` | `PROVEN` |
| Projects | `GET/POST /api/v1/projects`; `GET/DELETE /api/v1/projects/{project_id}`; `PATCH /api/v1/projects/{project_id}/business-profile`; `GET /business-profile/runs`; `GET /favicon`; `POST /business-profile/refresh` under the same project prefix | `PROVEN` |
| Audit runs | `GET/POST /api/v1/projects/{project_id}/audit-runs`; `GET/DELETE /{run_id}`; `POST /{run_id}/recalculate-issues`; `GET /activity`; `POST /pause`, `/resume`, `/stop`, `/archive`; `GET /issues`, `/pages`, `/links`, `/resources`, `/status-codes`, `/visualization`, `/pagespeed`, and `/export` under the audit-run prefix | `PROVEN` |
| Backlinks | No Backlinks route exists in the fetched remote commit; the local dirty checkout contains untracked Gateway adapters and a private Backlinks service | `PROVEN` |

The remote `backend/contracts/openapi/` directory contains only a README, so a
versioned exported remote OpenAPI artifact is not present. The remote
`backend/contracts/events/` directory also contains only a README, so no
versioned event payload is proven there.

### Table And Migration Inventory

The fetched SQLAlchemy model tree defines 11 tables:

`projects`, `site_profiles`, `crawl_runs`, `pages`, `page_snapshots`,
`link_edges`, `backlink_checks`, `audit_issues`, `external_resources`,
`crawl_checkpoints`, and `pagespeed_results`.

The Alembic chain is linear and has six revisions:

| Revision | Down revision | Principal objects | Label |
|---|---|---|---|
| `20260720_0001` | none | `crawl_runs`, `pages`, `page_snapshots`, `link_edges`, `backlink_checks` | `PROVEN` |
| `20260721_0002` | `20260720_0001` | `projects` | `PROVEN` |
| `20260721_0003` | `20260721_0002` | `site_profiles` and site-understanding changes | `PROVEN` |
| `20260721_0004` | `20260721_0003` | `audit_issues`, `crawl_checkpoints`, `pagespeed_results` | `PROVEN` |
| `20260722_0005` | `20260721_0004` | active technical-audit uniqueness/state changes | `PROVEN` |
| `20260722_0006` | `20260722_0005` | `external_resources` | `PROVEN` |

Repository definitions do not prove that these migrations are installed in
the local PostgreSQL 17.10 service or any production database.

### Workflow, Crawler, And Object Storage Inventory

| Item | Remote baseline | Label |
|---|---|---|
| Temporal namespace and queue | Namespace defaults to `default`; queue is `crawler-go` | `PROVEN` |
| Workflows | Go Worker registers `CrawlWorkflow` and `RecalculateIssuesWorkflow` | `PROVEN` |
| Activities | Go Worker registers `Activities.RunTask` and `Activities.RecalculateIssues` | `PROVEN` |
| Task types | `site_understanding`, `technical_audit`, and `backlink_validation` are defined in JSON Schema and Go types | `PROVEN` |
| Workflow IDs | Code starts site understanding as `crawler:site_understanding:{project_id}:{run_id}` and technical audit as `crawler:technical_audit:{run_id}`; recalculation/resume add unique suffixes | `PROVEN` |
| Contract mismatch hotspot | The Temporal README states `crawler:site_understanding:{project_id}`, while executable Project service code appends `{run_id}` | `PROVEN`; resolution deferred to `SEO4-INT-002` |
| Structured writes | Crawler repositories write the 11 Platform/Audit/Crawler tables through PostgreSQL | `PROVEN` repository capability; runtime application `UNKNOWN` |
| Object storage | Bucket defaults to `seo-crawler`; keys use `crawler/{organization_id}/{project_id}/{run_id}/...`, including page hashes, `result.json`, and `site-icon` | `PROVEN` |
| Backlink validation caller | The task type and Worker handling exist, but no fetched FastAPI route that starts a backlink-validation task was found | `PROVEN` absence; caller ownership `UNKNOWN` |

### Compose And Current Runtime

The fetched `deploy/compose/compose.yaml` defines eight services:
`postgres`, `redis`, `minio`, `minio-init`, `temporal`, `api`,
`crawler-worker`, and `frontend`.

| Port/service | Compose default | Current local runtime | Label |
|---|---|---|---|
| Frontend | `8080 -> 80` | Vite is separately listening at `127.0.0.1:4174`, PID 21288; HTTP 200, `text/html` | `PROVEN` |
| FastAPI | `8000` | no listener | `PROVEN` |
| PostgreSQL | `5432` | Windows service `postgresql-x64-17` is Running/Auto; PostgreSQL 17.10 accepts connections | `PROVEN` |
| Redis | `6379` | no listener | `PROVEN` |
| Temporal API/UI | `7233` / `8233` | no listeners | `PROVEN` |
| MinIO API/console | `9000` / `9001` | no listeners | `PROVEN` |
| Compose frontend | `8080` | no listener | `PROVEN` |
| Docker | n/a | Docker Engine 29.6.2 is available; `docker ps` and `docker compose ls` show no active container or Compose project | `PROVEN` |

The remote Compose file pins PostgreSQL 18, while the current Windows service
is PostgreSQL 17.10. No combined migration, backup/restore, or PostgreSQL 18
runtime gate was executed by this task.

### Dirty File Manifest

The local product checkout has these 19 tracked changes:

```text
M backend/api/.env.example
M backend/api/app/api/router.py
M backend/api/app/api/routes/health.py
M backend/api/app/core/config.py
M backend/api/app/main.py
M backend/api/pyproject.toml
M backend/api/uv.lock
M backend/contracts/events/README.md
M backend/contracts/openapi/README.md
M backend/contracts/temporal/README.md
M frontend/README.md
M frontend/src/App.tsx
M frontend/src/api/client.ts
M frontend/src/app/app-shell.tsx
M frontend/src/components/agent/agent-dock.tsx
M frontend/src/components/shared/page-header.tsx
D frontend/src/data/mock-data.ts
M frontend/src/index.css
M frontend/src/pages/module-page.tsx
M frontend/src/pages/overview-page.tsx
```

The exact 255-file untracked manifest was produced with
`git ls-files --others --exclude-standard`. Its complete path partition is:

| Path partition | Files | Label |
|---|---:|---|
| `backend/api/**` | 10 | `PROVEN` |
| `backend/contracts/**` | 5 | `PROVEN` |
| `backend/core/**` | 182 | `PROVEN` |
| `backend/database/**` | 1 | `PROVEN` |
| `docs/architecture/**` | 6 | `PROVEN` |
| `docs/SEO...V1.2.md` | 1 | `PROVEN` |
| `frontend/.playwright-cli/**` | 18 | `PROVEN` |
| `frontend/output/**` | 4 | `PROVEN` |
| `frontend/src/**` | 28 | `PROVEN` |

No untracked local file has the same exact path as a file changed by the
fetched remote commit.

### Collision Hotspots And Non-Overwrite Set

Fourteen tracked dirty paths are also changed by `origin/main` and therefore
must not be overwritten, checked out, or auto-resolved:

```text
backend/api/.env.example
backend/api/app/api/router.py
backend/api/app/core/config.py
backend/api/app/main.py
backend/api/pyproject.toml
backend/api/uv.lock
backend/contracts/temporal/README.md
frontend/src/App.tsx
frontend/src/app/app-shell.tsx
frontend/src/components/agent/agent-dock.tsx
frontend/src/components/shared/page-header.tsx
frontend/src/data/mock-data.ts
frontend/src/pages/module-page.tsx
frontend/src/pages/overview-page.tsx
```

The remaining local dirty paths are also preservation inputs even when they do
not collide by exact filename, especially `backend/core/**`,
`backend/database/**`, `docs/architecture/**`, generated shared contracts,
Gateway adapters, and module-registered frontend features.

The remote committed Project/Audit/Crawler baseline must likewise be preserved
for later comparison, especially:

- `backend/api/app/api/routes/projects.py`
- `backend/api/app/api/routes/audits.py`
- `backend/api/app/modules/projects/**`
- `backend/api/app/modules/audit/**`
- `backend/api/app/modules/crawling/**`
- `backend/api/migrations/versions/20260720_0001` through `20260722_0006`
- `backend/crawler/**`
- `deploy/compose/compose.yaml`
- `frontend/src/api/projects.ts`
- `frontend/src/api/audits.ts`
- `frontend/src/features/projects/**`
- `frontend/src/features/audit/**`

This is a baseline protection list, not a `KEEP/ADAPT/MERGE/REPLACE`
classification. That classification belongs to `SEO4-INT-002`.

### Remaining Gates

- `PROVEN`: the real repository source and baseline SHA are now available.
- `PROVEN`: no merge, rebase, pull, checkout, commit, or push occurred.
- `UNKNOWN`: authenticated remote ownership and independent review; the remote
  tree has no `.github/CODEOWNERS`.
- `UNKNOWN`: authoritative Auth/Membership implementation and production
  Project Context.
- `UNKNOWN`: deployed Compose, FastAPI, Temporal, Redis, MinIO, Crawler, and
  PostgreSQL 18 state.
- `UNKNOWN`: production database migration application and backup/restore
  evidence.
- `PROVEN`: `SEO4-INT-002`, `SEO4-INT-003`, and `SEO4-INT-005` were not
  executed by this task.
- `PROVEN`: `SEO-V4-REPO-GATE` and `SEO-V4-ROUTE-GATE` remain pending.
