# Shared Contract And Runtime Namespaces

> Task: `BL-AI-ARCH-006`
> Date: `2026-07-23`
> Scope: aggregate OpenAPI, event registry, Temporal identifiers, Worker
> permissions, and Provider Kill Switch ownership

This gate implements the contract boundaries accepted by ADR-BL-0003. Repository
contracts and disposable local tests are `PROVEN`. Deployed Platform, Temporal,
Worker, and production database state remain `UNKNOWN`.

## OpenAPI Gate

The Backlinks module contract remains independently generated at
`backend/contracts/openapi/backlinks.v1.json`. It contains eight operations,
including private `GET /health` with operation ID
`backlinksPrivateHealthV1`.

The public aggregate is generated at
`backend/contracts/openapi/platform.v1.json`. It contains Platform
`GET /health` with operation ID `platformHealthV1` plus the seven public
Backlinks operations. The private Backlinks health operation is excluded.

The aggregate checker rejects:

- a duplicate HTTP method and path;
- a missing or duplicate `operationId`;
- a duplicate component or schema name.

Imported module operations retain their source identity through
`x-growthos-module`. The source module document is not rewritten by the
aggregation function.

Run the gate with:

```powershell
docker run --rm -v "${PWD}:/workspace" -w /workspace/backend/api python:3.13-slim sh -lc "pip install -q fastapi pydantic-settings httpx pytest ruff && python scripts/check_shared_contracts.py && pytest -q && ruff check app scripts tests"
```

## Event Registry

| Event | Fact/outbox owner | Consumers | Payload | Dedupe | Status |
|---|---|---|---|---|---|
| `backlinks.project-analysis.requested.v1` | `backlinks` | `backlinks` | Version 1 | `workflowId` | `PROVEN` module-internal |

`backend/contracts/events/registry.v1.json` is authoritative. The
`crossModuleEvents` list is empty, so this task introduces no cross-module
event. The checker requires names to be owner-prefixed and versioned, requires
the outbox owner to match the fact owner, and permits a cross-module consumer
only when the event is listed and its write policy is `projection-only`.

## Temporal Registry

| Contract | Value | Status |
|---|---|---|
| Task Queue | `growthos.backlinks.v1` | `PROVEN` repository and disposable runtime |
| Project-analysis Workflow type | `backlinksProjectAnalysisV1Workflow` | `PROVEN` |
| Project-analysis Workflow ID | `backlinks:<workspaceId>:<websiteProjectId>:project-analysis:v1:<instanceId>` | `PROVEN` |
| Recommendation-refill Workflow type | `backlinksRecommendationRefillV1Workflow` | `PROVEN` |
| Recommendation-refill Workflow ID | `backlinks:<workspaceId>:<websiteProjectId>:recommendation-refill:v1:<instanceId>` | `PROVEN` |
| Activity types | `backlinksLoadProjectAnalysisContextV1`, `backlinksReserveRecommendationRefillV1`, `backlinksExecuteRecommendationRefillV1`, `backlinksRecordRecommendationRefillFailureV1` | `PROVEN` |

`backend/contracts/temporal/registry.v1.json` is authoritative. The checker
rejects a shared or unprefixed Task Queue, a Workflow type or Activity type
without a module prefix and version, and a Workflow ID pattern without the
module, Workspace, Website Project, workflow kind, and version.

Audit, Keywords, and Content runtime contracts are not present in the inspected
repository and remain `UNKNOWN`. The deployed Temporal namespace, active
pollers, Workflow histories, and deployment owners also remain `UNKNOWN`.

## Worker And Provider Boundaries

The Backlinks Worker runtime contract is restricted to database role
`growthos_backlinks_writer` and schema `backlinks`. The registry rejects a role
or schema outside that module boundary.

DataForSEO uses the module-owned Kill Switch
`backlinks.dataforseo.v1`. Existing Backlinks quota, budget, cache, and usage
ledger gates remain in place. Tests used injected fakes and disposable
infrastructure only; no real or paid Provider request was made.

## Verification

- `PROVEN`: OpenAPI conflict fixtures reject duplicate route, `operationId`,
  and schema names.
- `PROVEN`: the module contract has eight operations and the public aggregate
  has eight operations: one Platform health operation and seven Backlinks
  operations.
- `PROVEN`: event and Temporal registries pass the shared checker, with zero
  cross-module events and one module-specific Task Queue.
- `PROVEN`: disposable Temporal execution used the namespaced queue, Workflow
  type, Workflow ID, and Activity type through failure, Worker restart, and
  completion.
- `PROVEN`: TypeScript unit, API, contract, security, and integration suites
  pass; Python `pytest` and Ruff pass.
- `UNKNOWN`: production deployment, active Worker permissions, and provider
  operational state were not inspected or changed.

## Task Boundary

No frontend synchronization, real Provider call, production or persistent
database mutation, `BL-AI-ARCH-007`, `BL-AI-074`, Git commit, or Git push was
performed.

## SEO4-INT-005 Addendum

> Snapshot date: `2026-07-24`
> Source baseline: `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`

This addendum extends the historical `BL-AI-ARCH-006` registry without
rewriting its evidence.

### OpenAPI

- `PROVEN`: the real source FastAPI `app.openapi()` contains 23 paths and 27
  operations: one private health operation, eight Platform Project operations,
  and 18 Audit operations.
- `PROVEN`: the generated public aggregate contains 30 paths and 34 operations:
  one current Platform health operation, eight Project operations, 18 Audit
  operations, and seven Backlinks operations.
- `PROVEN`: private source and Backlinks health paths are excluded. Source
  operation IDs are retained, operation ownership is tagged, and every module
  route receives the canonical Gateway 503 problem response.
- `PROVEN`: duplicate route, operation ID, and conflicting schema fixtures
  fail. Byte-identical schema components are deduplicated.
- `UNKNOWN`: the source Project/Audit handlers are not yet composed into the
  current running Gateway; this aggregate is a checked contract artifact, not
  product E2E evidence.

### Commands And Events

| Kind | Name | Owner | Producers/consumers | Dedupe | Write policy |
|---|---|---|---|---|---|
| Command | `crawling.evidence.requested.v1` | Crawling | Platform, Audit, Backlinks produce | `requestId` | Crawling evidence only |
| Event/result | `crawling.evidence.recorded.v1` | Crawling | Platform, Audit, Backlinks consume | `requestId` | Consumer projection only |
| Event | `backlinks.project-analysis.requested.v1` | Backlinks | Backlinks only | `workflowId` | Backlinks-owned Outbox |

### Temporal And Providers

| Module | Queue | Contract status | Database access | Provider Kill Switch |
|---|---|---|---|---|
| Platform | `growthos.platform.v1` | Target contract | `platform` writer | `platform.business-profile-ai.v1` |
| Audit | `growthos.audit.v1` | Target contract | `audit` writer | `audit.google-pagespeed.v1` |
| Crawling | `growthos.crawling.v1` | Executable | None | None |
| Backlinks | `growthos.backlinks.v1` | Executable | `backlinks` writer | `backlinks.dataforseo.v1` |

The real source bindings `crawler-go`, `CrawlWorkflow`,
`RecalculateIssuesWorkflow`, `Activities.RunTask`,
`Activities.RecalculateIssues`, `pause`, and `stop` are retained as source
evidence but marked `replacement-required`. They cannot be active shared
identifiers after integration.

### Crawler Evidence Boundary

`crawler.evidence.v1` preserves the real three task types and object key prefix
`crawler/<organizationId>/<websiteProjectId>/<runId>/`. It returns observed
pages, contacts, backlink presence, technical values, and artifact references.
It contains no final Project health, Audit issue conclusion, Opportunity,
Placement, recommendation, contact-purpose inference, or lifecycle state.

`SEO4-INT-006` adapted the source Go crawler into the target executable
contract. The retained Worker emits evidence and object-store artifacts only,
has no database dependency or credential, and cannot write Project, Audit, or
Backlinks business facts. The source PostgreSQL writer and business-profile
writer paths were not imported.

### Gate Result

`SEO-V4-ROUTE-GATE = PASS` for starting `BL-AI-078` through `BL-AI-080`.
This result proves contract compatibility and namespace isolation only. It does
not claim that Project/Audit routes are already live in the current Gateway or
that the combined product has passed E2E.

`SEO-V4-CRAWLER-GATE = PASS`. The repository now contains an executable
`growthos.crawling.v1` Worker using the exact versioned Workflow, Activity,
Signal, and Query names, SafeFetch Gold Set controls, static-first fetching,
conditional Browser fallback, deterministic artifact references, and an
evidence-only result. This is repository and disposable-test proof, not a claim
of a deployed Temporal poller, production object store, or product E2E.
