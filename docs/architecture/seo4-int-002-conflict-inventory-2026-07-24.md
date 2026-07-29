# SEO4-INT-002 Exact Conflict Inventory

Date: `2026-07-24`

Task result: `SEO4-INT-002 = DONE`

This inventory is frozen against:

- local checkout: `main@a9380e70a571b722f0ffdbfdb7b0adfc318faee4`;
- coworker baseline: `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`;
- branch relation: local is 0 ahead and 1 behind;
- pre-task working tree: 20 tracked status entries, 19 tracked content deltas,
  and 255 untracked paths;
- final working tree: the same tracked baseline and 256 untracked paths after
  adding this inventory.

`git fetch --prune origin` completed before this inventory and did not change
the remote baseline. No pull, merge, rebase, checkout, commit, or push was
performed.

## Classification

| Decision | Meaning |
|---|---|
| `KEEP` | Preserve the existing implementation and its ownership boundary. |
| `ADAPT` | Preserve the implementation, but change its integration boundary or contract in a later task. |
| `MERGE` | Combine both implementations without dropping either owned capability. |
| `REPLACE` | Retire a prototype, mock, stale document, or superseded implementation after replacement proof exists. |
| `BLOCKED` | Do not integrate until the named owner, authority, or runtime proof exists. |

## Exact Path Conflicts

Fourteen tracked paths have content changes on both the local worktree and the
coworker baseline.

| Path | Local responsibility | Coworker responsibility | Decision | Evidence |
|---|---|---|---|---|
| `backend/api/.env.example` | Private Backlinks Core URL, timeout, and signing configuration | PostgreSQL, Temporal, Crawler, S3, PageSpeed, and AI provider configuration | `MERGE` | `PROVEN` |
| `backend/api/app/api/router.py` | Backlinks Gateway router | Project and Audit routers | `MERGE` | `PROVEN` |
| `backend/api/app/core/config.py` | Backlinks Gateway and fail-closed signing settings | Async database, Temporal, Crawler, S3, and provider settings | `MERGE` | `PROVEN` |
| `backend/api/app/main.py` | Injectable Backlinks Gateway lifecycle and shutdown | Audit reconciliation and Crawler worker lifecycle | `MERGE` | `PROVEN` |
| `backend/api/pyproject.toml` | Runtime `httpx` dependency | `asyncpg`, `boto3`, and `openpyxl` dependencies | `MERGE` | `PROVEN` |
| `backend/api/uv.lock` | Lock generated for the local Gateway dependency set | Lock generated for the coworker Platform dependency set | `REPLACE` | `PROVEN`; regenerate from the merged `pyproject.toml`, never hand-merge |
| `backend/contracts/temporal/README.md` | Backlinks namespaced queue and registry policy | Crawler workflow documentation | `MERGE` | `PROVEN` |
| `frontend/src/App.tsx` | Registered module routing and Backlinks project entry | Real `/projects` and project-module routing | `MERGE` | `PROVEN` |
| `frontend/src/app/app-shell.tsx` | Module registry, preserved navigation, and Backlinks project entry | Real Project provider, selector, and shell data | `MERGE` | `PROVEN` |
| `frontend/src/components/agent/agent-dock.tsx` | Shared shell adapted away from global mock data | Coworker shared shell behavior | `MERGE` | `PROVEN` |
| `frontend/src/components/shared/page-header.tsx` | Shared presentation without feature-owned mock state | Coworker project-aware header behavior | `MERGE` | `PROVEN` |
| `frontend/src/data/mock-data.ts` | Deleted to remove shared feature state | Modified and still imported by five coworker shared components/pages | `REPLACE` | `PROVEN`; do not restore the cross-module mock |
| `frontend/src/pages/module-page.tsx` | Generic module frame delegated through the registry | Hard-coded Audit, Keywords, Content, Backlinks, and Performance page behavior | `MERGE` | `PROVEN` |
| `frontend/src/pages/overview-page.tsx` | Shared overview without feature-private mock imports | Coworker project overview behavior | `MERGE` | `PROVEN` |

There are zero exact path collisions between local untracked files and the
coworker tree. `frontend/src/api/client.ts` is marked modified by the worktree,
but its worktree blob equals local `HEAD`; it is not a local content delta.
The coworker baseline does change that file, so it remains an `ADAPT` surface
for the later frontend merge.

## Path-Level Decisions

| Surface | Decision | Required later action | Evidence |
|---|---|---|---|
| `backend/api/app/api/routes/health.py` | `KEEP` | Keep one public Platform health source. Do not expose private Fastify health as a second public route. | `PROVEN` |
| Local `backend/api/app/api/routes/backlinks.py` and Backlinks Gateway/context files | `KEEP` | Compose them with Project and Audit routes in `SEO4-INT-003` and `SEO4-INT-005`. | `PROVEN` |
| Coworker Project and Audit route/service/model files | `KEEP` | Preserve real Project and Audit behavior, then add authoritative context and ownership controls. | `PROVEN` |
| Local OpenAPI, Events, and Temporal registries | `ADAPT` | Aggregate the coworker runtime contracts and add Platform, Audit, and Crawling registrations in `SEO4-INT-005`. | `PROVEN` |
| Coworker `backend/crawler/**` | `KEEP` | Preserve the Go Crawler, SSRF controls, robots handling, and evidence production. | `PROVEN` |
| Coworker `backend/browser-worker/**` deletion | `REPLACE` | Accept replacement by the proven Rod-based Go implementation only after Crawler-owner review. | `PROVEN` implementation; owner `UNKNOWN` |
| Local Backlinks domain, database, API, and workers | `KEEP` | Keep Fastify private and preserve Backlinks-only facts and writers. | `PROVEN` |
| Coworker `frontend/src/features/projects/**` | `KEEP` | Use it as Platform Project master-data UI. | `PROVEN` |
| Local `frontend/src/app/project-context.ts` prototype | `REPLACE` | Replace with the real Project context during `SEO4-INT-003`; keep signed server context fail-closed. | `PROVEN` |
| Coworker real Audit workspace and local Audit registration/mock | `MERGE` | Register the real Audit workspace through the local module contract and remove the Audit mock after parity proof. | `PROVEN` |
| Local Backlinks `frontend/src/features/projects/project-workspace.tsx` | `ADAPT` | Keep Website Projects inside Backlinks and consume authoritative Platform Project context; do not create a second Platform CRUD. | `PROVEN` |
| `frontend/src/index.css` local density change | `KEEP` | Preserve the established 16px root density in the later three-way merge. | `PROVEN` |
| Coworker Compose file | `ADAPT` | Keep its eight-service base and add private Backlinks runtime dependencies without a browser-visible Fastify port. | `PROVEN` |

## Capability-Level Decisions

| Capability | Decision | Boundary | Evidence |
|---|---|---|---|
| Website Project master data | `KEEP` | Platform owns `projects` and `site_profiles`; Backlinks consumes signed context and may keep immutable project snapshots. | `PROVEN` |
| Authentication and membership authority | `BLOCKED` | No real identity, membership, or authorization authority exists in the fetched baseline. `default_organization_id = "local"` cannot be production authority. | `PROVEN` absence; owner `UNKNOWN` |
| `PlatformRequestContext.v1` | `ADAPT` | Keep the signed, fail-closed consumer contract and replace the default rejecting/local resolver with real Project/Auth resolution in `SEO4-INT-003`. | `PROVEN` |
| Audit conclusions | `KEEP` | Audit owns `audit_issues` and PageSpeed-derived audit conclusions. Backlinks audit rows remain its internal command trail, not a duplicate conclusion store. | `INFERRED` from approved ownership |
| Crawl and page evidence | `ADAPT` | Crawler produces crawl evidence only. Its direct updates across Platform and Audit facts must be replaced by owned commands/contracts. | `PROVEN` writes; target boundary `INFERRED` |
| Backlink validation evidence | `ADAPT` | Crawler may produce validation evidence; Backlinks alone commands monitoring and owns Placement/link lifecycle facts. | `PROVEN` overlap; target boundary `INFERRED` |
| Backlinks Opportunity, outreach, Placement, and lifecycle | `KEEP` | Backlinks Core remains the only writer and stays private behind FastAPI. | `PROVEN` |
| Object storage | `KEEP` | Preserve `crawler/{organization_id}/{project_id}/{run_id}/...`, including page hashes and `site-icon`; publish it as a versioned contract in `SEO4-INT-005`. | `PROVEN` |
| Temporal module isolation | `ADAPT` | Preserve existing histories, but register module-prefixed queues, workflows, activities, and IDs. | `PROVEN` current names; target boundary `INFERRED` |
| Provider ownership | `ADAPT` | DataForSEO remains Backlinks-scoped. PageSpeed and Business Profile AI remain Platform/Audit-scoped and require default-off, module-prefixed kill switches. | `PROVEN`; missing kill switches `PROVEN` |
| Public API composition | `MERGE` | FastAPI remains the only public Gateway and must expose Project, Audit, and Backlinks routes exactly once. Fastify remains private. | `PROVEN` |
| Shared frontend shell | `MERGE` | Preserve coworker Projects/Audit and the local registered Backlinks workspace through a three-way merge. No whole-file overwrite is allowed. | `PROVEN` |

## Duplicate Inventory

### Routes

- `PROVEN`: the coworker FastAPI surface has 27 operations: one health, eight
  Project, and 18 Audit operations.
- `PROVEN`: the current local aggregate has eight operations: one health and
  seven public Backlinks operations.
- `PROVEN`: there is no exact method/path duplicate among Project, Audit, and
  Backlinks operations.
- `ADAPT`: the target aggregate is 34 public operations because health is
  included once.
- `ADAPT`: normalize the route identity contract around `project_id` versus
  `websiteProjectKey`; this is a parameter/binding conflict, not a duplicate
  route.

### Tables

The coworker Alembic stream owns 11 currently unqualified tables:

`projects`, `site_profiles`, `crawl_runs`, `pages`, `page_snapshots`,
`link_edges`, `backlink_checks`, `audit_issues`, `external_resources`,
`crawl_checkpoints`, and `pagespeed_results`.

There is no exact table-name duplicate with the 25 Backlinks-owned tables.
The following semantic overlaps require ownership adaptation:

| Coworker fact | Backlinks fact | Decision |
|---|---|---|
| `projects` | `backlink_project_context_snapshots` | `KEEP`; authority versus read-only consumer snapshot |
| `link_edges` and `backlink_checks` | Placement and link lifecycle | `ADAPT`; crawl evidence versus Backlinks business fact |
| `audit_issues` | `backlink_audit_events` | `KEEP`; audit conclusion versus Backlinks command audit trail |

### Workflows

- `PROVEN`: Crawler queue `crawler-go`, workflows `CrawlWorkflow` and
  `RecalculateIssuesWorkflow`, and activities `Activities.RunTask` and
  `Activities.RecalculateIssues` do not exactly duplicate the existing
  Backlinks queue, workflows, or activities.
- `ADAPT`: Crawler task `backlink_validation` overlaps future Backlinks
  monitoring by capability; Crawler returns evidence and Backlinks owns the
  command, schedule, and lifecycle transition.
- `REPLACE`: the coworker Temporal README documents
  `crawler:site_understanding:{project_id}`, while executable code and tests
  use `crawler:site_understanding:{project_id}:{run_id}`. The executable
  contract wins and the stale documentation must be replaced in
  `SEO4-INT-005`.

### Providers

- `PROVEN`: there is no exact provider duplicate. Backlinks uses DataForSEO;
  the coworker baseline uses Google PageSpeed, configurable Business Profile
  AI, proxy support, and direct crawl transport.
- `KEEP`: Backlinks SafeFetch remains limited to Backlinks contact discovery
  and robots-aware retrieval.
- `ADAPT`: generic crawl and audit fetches remain in Crawler.
- `BLOCKED`: PageSpeed and Business Profile AI cannot be enabled as production
  providers until module-prefixed default-off kill switches and accountable
  owners are recorded.

## Migration Order Draft

1. Freeze both migration streams, checksums, database roles, and a restorable
   pre-integration backup. Do not rewrite released revisions.
2. In `SEO4-INT-004`, add the missing `crawling` schema and role to the shared
   bootstrap before assigning Crawler-owned tables.
3. Apply the coworker Alembic chain unchanged through
   `20260722_0006_external_resources`.
4. Add new forward-only Alembic bridge revisions for domain schemas, owners,
   grants, RLS, and `search_path`; do not make Crawler a writer of Platform or
   Audit business facts.
5. Apply the Backlinks migration chain unchanged through
   `0007_backlink_opportunity_counter.sql`; its `0005` revision remains the
   authority for moving Backlinks tables into the `backlinks` schema.
6. Add only versioned projections, commands, events, and grants required for
   cross-module consumption. No table may have two business writers.
7. Produce one deployment manifest and prove clean install, upgrade, role/RLS
   isolation, backup, and restore on PostgreSQL 18 before promotion.

Implementation order after this inventory is:
`SEO4-INT-003` for Project/Auth/context, `SEO4-INT-004` for database ownership,
and `SEO4-INT-005` for OpenAPI, Events, Temporal, Crawler, object-storage, and
provider contracts.

## Ownership And Blockers

Existing repository-local review records assign Platform API, Context,
Contracts, Frontend, Backlinks, Architecture, and affected Audit review scope
to `tianyulong23-dotcom`. Remote commit authorship by `john3947` is evidence of
authorship only and is not ownership approval.

The following remain `BLOCKED`:

- production authentication and membership authority;
- Crawler owner and reviewer;
- database operations owner and PostgreSQL 18 promotion authority;
- authenticated remote repository owner approval;
- shared frontend merge approval across Platform, Project, Audit, and
  Backlinks;
- production provider enablement without namespaced kill switches.

`SEO-V4-ROUTE-GATE` remains pending until `SEO4-INT-003` and
`SEO4-INT-005` are complete. `SEO-V4-CRAWLER-GATE` remains pending until the
database, contract, and Crawler adapter tasks are complete.

This task classified conflicts only. It did not resolve a conflict, modify
business code, change a dependency, run a paid provider, use supplied
credentials, mutate a database, synchronize the frontend, or perform a Git
integration action.
