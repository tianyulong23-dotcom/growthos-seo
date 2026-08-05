# ADR-BL-0002: Backlinks Runtime Stack

- Status: Accepted
- Date: 2026-07-21
- Amended: 2026-07-22
- Scope: `backend/core`

## Context

The maintained V1.2 coding plan fixes the backlinks backend on the shared
TypeScript Core. The repository still contains FastAPI, Python worker, Go
crawler, and Browser worker skeletons, but they are not evidence that backlinks
should run a second API, worker authority, or business database.

The runtime choice must preserve the bounded context established by
ADR-BL-0001: PostgreSQL is the business system of record, Temporal provides
durable orchestration, and framework or vendor types cannot enter the domain.
Exact runtime and package versions also need to be reproducible through the
lockfile, CI, container provenance, and the source manifest created by later
tasks.

The approved documents did not originally specify an exact PostgreSQL Server
release or container digest. On 2026-07-22, the platform owner selected
PostgreSQL `17.10-2` for conservative Windows-local migration validation.
Production remains blocked until its immutable container digest and recovery
runbook are approved.

## Decision

### Runtime baseline

| Component | Exact version or pin | License | Adoption and boundary |
|---|---|---|---|
| Node.js | `v24.14.1` | MIT | Fixed runtime for Core API, Worker, tests, and scripts |
| npm CLI | `11.11.0`; commit `1e7774ee4bc98e434339b0969e9caa98c583060c` | Artistic-2.0 | Fixed package manager and lockfile producer |
| Fastify | `5.10.0` | MIT | Direct dependency imported only by the API adapter and plugin composition |
| Drizzle ORM | `0.45.2` | Apache-2.0 | Direct dependency limited to database schema, repositories, and tests |
| node-postgres | `8.22.0` | MIT | Direct dependency for PostgreSQL connections, transactions, and reviewed raw SQL |
| Temporal TypeScript SDK | `1.20.2` | MIT | Direct dependency behind the Worker adapter for Workflows, Activities, clients, and tests |
| PostgreSQL Server | Windows package `17.10-2`; server `17.10`; installer SHA-256 `81554536268e499f431efa3fa20736736c64102c719308a03ceb32aa0cb6ae06` | PostgreSQL License | Approved for local migration validation; production still requires an immutable image digest |

The PostgreSQL row is not permission to use `latest` or an unversioned service.
Local validation uses only built-in PostgreSQL capabilities and `plpgsql`; no
optional extension is required by `0001_backlink_foundation`. A later patch
upgrade must first create a separate disposable cluster, restore a fresh
backup, run all forward migrations, and pass constraint and isolation tests.
Rollback for this local validation environment is application rollback plus a
fresh cluster restore; destructive schema downgrade is prohibited. Production
release acceptance still requires an immutable image digest and the
platform-owned backup, PITR, RPO, and RTO runbook.

### Process topology

- `core-api` registers the Backlinks Fastify plugin.
- `core-worker` registers Backlinks Temporal Workflows and Activities.
- Both processes use the same Core contracts and the same PostgreSQL business
  database.
- Backlinks creates neither a second business API nor a second database.
- PostgreSQL stores final business facts. Temporal history, Search Attributes,
  Fastify memory, and frontend state are not fallback systems of record.

### Framework boundaries

- Fastify converts HTTP input into validated Actor, Tenant, Project, and
  backlinks command/query inputs. Domain services never receive
  `FastifyRequest` or `FastifyReply`.
- Temporal Workflows orchestrate deterministic control flow. Activities perform
  network and database I/O through application Ports and domain commands.
- Drizzle provides typed PostgreSQL schema and queries. `pg` owns connections,
  transactions, timeouts, and necessary reviewed SQL.
- Fastify, Drizzle rows, PostgreSQL driver objects, Temporal types, and provider
  DTOs remain outside the domain layer.
- ORM schema push, startup auto-migration, application-only tenant filtering,
  and unreviewed destructive SQL are prohibited.
- Database connections must eventually set reviewed `statement_timeout`,
  `lock_timeout`, and `application_name` values.

### Version enforcement

BL-AI-004 must write `"packageManager": "npm@11.11.0"` and
`"engines": { "node": "24.14.1" }`, then generate a committed lockfile with
exact dependency versions and integrity values. Dependency declarations may not
use `^`, `~`, `latest`, or floating Git references.

CI and containers must verify Node `v24.14.1` and npm `11.11.0`. A container
must pin an immutable image digest rather than only a moving tag such as
`node:24`. Build provenance, the source manifest, SBOM, and notices must agree
with the selected runtime and licenses.

This ADR records decisions only. It does not create the package workspace,
container, database, migration, table, route, Workflow, Activity, or provider
connection.

## Rollback

### Common order

1. Activate the affected backlinks capability or provider kill switch.
2. Freeze deployments and migrations while preserving audit, workflow, outbox,
   provider identifiers, traces, lockfiles, and build provenance.
3. Stop new scheduling and drain or explicitly terminate named in-flight work;
   do not delete pending PostgreSQL facts.
4. Restore the last approved application artifact, lockfile, runtime image
   digest, and compatible adapter configuration.
5. Reconcile unknown external results and resume gradually by Workspace only
   after health, contract, isolation, and recovery checks pass.

### Component rollback

| Component | Rollback rule |
|---|---|
| Node.js and npm | Restore the previous approved exact runtime, lockfile, and image digest only after the compatibility matrix passes; do not suppress a security gate to force a downgrade |
| Fastify | Remove the Backlinks plugin from the Core registry or restore the previous Core artifact; OpenAPI, Problem Details, Actor/Tenant hooks, and command interfaces must remain stable |
| Drizzle and `pg` | Roll back application code while retaining a compatible Expand schema; replace through the same Repository Ports and real PostgreSQL tests, without dual writes |
| Temporal | Stop new schedules, drain or terminate specified Workflows, and restore the previous Worker Build ID; do not introduce BullMQ, pg-boss, or another temporary workflow authority |
| PostgreSQL | Prefer application rollback and forward-fix migrations; any server rollback, PITR, or failover follows the platform recovery runbook and must preserve audit, outbox, idempotency, and business facts |

Database migrations require expand/migrate/contract sequencing or an explicit
irreversibility statement. Destructive ad hoc downgrade SQL is not an accepted
rollback mechanism.

## Old Skeleton Disposition

| Current path | Decision | Migration and deletion condition |
|---|---|---|
| `frontend/` | Keep | Later replace backlinks mocks and bare requests with the generated Core client; never delete as part of runtime migration |
| `backend/api/` | Temporary evidence only; no formal backlinks business | Keep legacy `/health` during OSS-00. Remove it from scripts, README, and CI only after Core health, backlinks smoke, contract, isolation, and frontend cutover checks pass; delete only when it has no independent production owner, capability, or data |
| `backend/workers/` | No formal Backlinks Workflow or Activity | Backlinks work moves only to the TypeScript Core Worker. Retain Python workers solely for another module with a written owner; otherwise delete the empty registry or examples in a separate change |
| `backend/crawler/` | Platform candidate, not backlinks runtime | Backlinks V1 uses a TypeScript `SafeFetchPort`; the Go crawler cannot write Prospect, Contact, Opportunity, or Placement facts and stays outside the release without a platform ADR |
| `backend/browser-worker/` | Conditional isolated adapter | It may implement only `BrowserRendererPort`, with no database credentials or business writes; delete when browser capability is disabled and no other module owns it |
| `backend/contracts/` | Keep and regenerate | Core becomes the source for OpenAPI, event schemas, and Temporal payload schemas |
| `docs/SEO自动化平台-生产级技术架构文档-V1.0.md` | Historical reference | Mark its FastAPI direction as non-authoritative for backlinks and archive it after maintained documentation is consolidated |

FastAPI and Fastify must never expose the same backlinks route set. Python and
TypeScript workers must never register the same `Backlink*Workflow`, and old and
new runtimes must never dual-write PostgreSQL, Outbox, Job, Opportunity, Send,
Reply, or Placement state. Old skeleton deletion is a separate, reviewed
change; code is not copied into a `legacy` directory.

## Consequences

- Backlinks runtime and package upgrades require an ADR, exact pins, license and
  source checks, compatibility tests, and a rehearsed rollback.
- The API and Worker remain separate processes but share one TypeScript Core and
  one PostgreSQL authority.
- PostgreSQL `17.10-2` is approved for Windows-local migration validation;
  production remains blocked until the immutable image and recovery gates pass.
- Replacing Fastify, Drizzle/pg, or Temporal must preserve Ports and business
  contracts instead of changing the domain model.
- Existing skeletons may remain during migration without gaining backlinks
  ownership.

## Rejected

### Keep the FastAPI and Python worker skeletons as the backlinks runtime

Rejected because it creates parallel implementation and ownership paths that
conflict with the fixed TypeScript Core and Temporal SDK.

### Use Temporal, Fastify memory, or frontend state as business storage

Rejected because none provides the PostgreSQL constraints, tenant isolation,
auditable transactions, and recovery semantics required for business facts.

### Use SQLite or another local database until PostgreSQL is available

Rejected because it cannot prove PostgreSQL transactions, locks, constraints,
RLS, migrations, or failure behavior and would create a false compatibility
signal.

### Select an arbitrary PostgreSQL Server version in this module ADR

Rejected because the maintained source documents omit that platform pin. The
platform owner must select and own the exact release, image digest, upgrade
policy, and recovery contract before real database work begins.

### Add a second queue during Temporal rollback

Rejected because dual schedulers create duplicate side effects and conflicting
retry, timer, and workflow authorities.
