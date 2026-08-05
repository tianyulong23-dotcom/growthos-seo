# SEO4-INT-005 OpenAPI, Events, Temporal, And Crawler Contract

> Date: `2026-07-24`
> Result: `SEO4-INT-005 = DONE`
> Route gate: `SEO-V4-ROUTE-GATE = PASS`
> Crawler gate: `SEO-V4-CRAWLER-GATE = PENDING`

## Real Prerequisite Evidence

- `PROVEN`: `SEO4-INT-002 = DONE`.
- `PROVEN`: source baseline is
  `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`.
- `PROVEN`: a detached source worktree generated FastAPI `app.openapi()` under
  the source `backend/api/uv.lock`.
- `PROVEN`: the source snapshot has 23 paths and 27 operations: one private
  health operation, eight Project operations, and 18 Audit operations.
- `PROVEN`: the retained Backlinks module contract has eight operations,
  including private health; the current Platform Gateway owns public health.

## Changed Files

- `backend/api/app/core/openapi_aggregation.py`
- `backend/api/scripts/check_shared_contracts.py`
- `backend/api/tests/test_shared_contracts.py`
- `backend/contracts/openapi/README.md`
- `backend/contracts/openapi/seo4-platform-audit.v1.json`
- `backend/contracts/openapi/seo4-platform-audit.v1.provenance.json`
- `backend/contracts/openapi/platform.v1.json`
- `backend/contracts/events/README.md`
- `backend/contracts/events/registry.v1.json`
- `backend/contracts/temporal/README.md`
- `backend/contracts/temporal/registry.v1.json`
- `backend/contracts/json-schema/README.md`
- `backend/contracts/json-schema/crawler-evidence-request.v1.schema.json`
- `backend/contracts/json-schema/crawler-evidence.v1.schema.json`
- `docs/architecture/shared-contract-namespaces.md`
- `docs/architecture/shared-module-ownership.md`
- `docs/architecture/seo4-int-005-openapi-events-temporal-crawler-contract-2026-07-24.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

## Retained Capabilities

Source/coworker capabilities retained:

- exact Project and Audit routes, schemas, tags, and operation IDs from the
  fetched FastAPI baseline;
- the real crawler task types `site_understanding`, `technical_audit`, and
  `backlink_validation`;
- the object-storage prefix
  `crawler/<organizationId>/<websiteProjectId>/<runId>/`;
- source Temporal bindings are recorded as legacy evidence rather than erased;
- Google PageSpeed and Business Profile AI remain associated with their source
  domains.

Current checkout capabilities retained:

- Platform Gateway remains the only public API and owns `GET /health`;
- Backlinks keeps its independent OpenAPI source, seven public routes, private
  Fastify health, queue, workflows, activities, database writer, and DataForSEO
  Kill Switch;
- the existing Backlinks Outbox event remains module-internal.

## Replaced Capability And Reason

The target contract replaces the unprefixed shared source bindings
`crawler-go`, `CrawlWorkflow`, `RecalculateIssuesWorkflow`,
`Activities.RunTask`, `Activities.RecalculateIssues`, `pause`, and `stop` with
module-prefixed, versioned Platform/Audit/Crawling identifiers. This prevents
queue and history collisions and fixes ownership.

The target `crawler.evidence.v1` replaces the source crawler's cross-module
business-shaped result contract. Crawling may report observations and artifact
references, but cannot decide or write final Project, Audit, Opportunity,
Placement, recommendation, contact-purpose, or lifecycle state. The executable
Go adaptation is intentionally deferred to `SEO4-INT-006`.

## Contract Result

- Public aggregate: 30 paths, 34 operations.
- Operation ownership: Platform 8, Audit 18, Backlinks 7, plus Platform health.
- Conflicts: no method/path, operation ID, differing schema, or Gateway 503
  error conflict.
- Commands: `crawling.evidence.requested.v1`, dedupe `requestId`.
- Cross-module result: `crawling.evidence.recorded.v1`, dedupe `requestId`,
  projection-only consumers.
- Queues: `growthos.platform.v1`, `growthos.audit.v1`,
  `growthos.crawling.v1`, and `growthos.backlinks.v1`.
- Kill Switches: `platform.business-profile-ai.v1`,
  `audit.google-pagespeed.v1`, and `backlinks.dataforseo.v1`.

## Verification

| Command | Exit | Result |
|---|---:|---|
| `uv run --frozen pytest -p no:cacheprovider tests/test_shared_contracts.py -q` | `0` | `4 passed` |
| `uv run --frozen ruff check app/core/openapi_aggregation.py scripts/check_shared_contracts.py tests/test_shared_contracts.py` with container-local Ruff cache | `0` | All checks passed |
| `uv run --frozen python scripts/check_shared_contracts.py` | `0` | 30 paths, 34 operations, one cross-module command, one cross-module event, four queues |
| `uv run --frozen pytest -p no:cacheprovider -q` | `0` | FastAPI `24 passed` |
| `uv run --frozen ruff check app scripts tests` | `0` | All checks passed |
| `npm run test:backlinks:contract` | `0` | Backlinks Contract `49 passed` |
| `npm run openapi:backlinks:check` | `0` | Backlinks OpenAPI baseline valid with 8 paths |

The first Ruff invocation exited `1` only because a read-only repository mount
prevented creation of `.ruff_cache`. Re-running with `RUFF_CACHE_DIR` under
`/tmp` exited `0`.

## Remaining Declared Or Unknown

- `UNKNOWN`: target Platform, Audit, and Crawling Worker implementations under
  the new identifiers.
- `UNKNOWN`: replay, restart, cancellation, and active poller evidence for
  those target Workers.
- `UNKNOWN`: production Provider Kill Switch wiring and operational state.
- `UNKNOWN`: authenticated source repository Owner approval.
- `UNKNOWN`: live composition of source Project/Audit handlers into the current
  FastAPI Gateway.
- `PROVEN pending adaptation`: the source Go worker still uses legacy Temporal
  names and directly writes Project/Audit business tables.

## Owner Review

Both sides' review scopes were triggered and recorded:
`ROLE-PLATFORM-CONTRACTS`, `ROLE-PLATFORM-API`, `ROLE-AUDIT`,
`ROLE-CRAWLER`, and `ROLE-BACKLINKS`. Repository-local scope assignment exists,
but the Crawler role staffing and authenticated external Owner approval remain
`UNKNOWN`. Triggering review does not equal merge approval.

## Gate And Next Task

`SEO-V4-ROUTE-GATE = PASS` because `SEO4-INT-001`, `SEO4-INT-002`,
`SEO4-INT-003`, and `SEO4-INT-005` are `DONE`, and the checked aggregate has no
route, operation ID, schema, error, or namespace conflict. This authorizes
starting `BL-AI-078`; it is not product E2E evidence.

`SEO-V4-CRAWLER-GATE` remains pending because `SEO4-INT-004` and
`SEO4-INT-006` are not complete and the executable Go worker has not been
adapted. The next allowed task on the route track is `BL-AI-078`. It was not
executed by this task.
