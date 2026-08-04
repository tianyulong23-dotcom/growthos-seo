# SEO4-INT-006 Go Crawler Evidence Adapter

> Date: `2026-07-24`
> Result: `SEO4-INT-006 = DONE`
> Crawler gate: `SEO-V4-CRAWLER-GATE = PASS`
> Source baseline: `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`

## Scope And Prerequisites

- `PROVEN`: `SEO4-INT-004 = DONE` and `SEO4-INT-005 = DONE`.
- `PROVEN`: the coworker Go crawler source was inspected from the frozen
  baseline and adapted under `backend/crawler/**`.
- `PROVEN`: only Crawler implementation, Crawler contracts/tests, shared
  contract validation, architecture records, and Coding State were changed.
- `PROVEN`: no frontend synchronization, production resource, paid Provider,
  supplied credential, Git commit, or Git push was used.

## Retained And Excluded Source

Retained crawler capabilities include HTTP collection, parsing, robots,
request limiting, sitemap discovery, technical issue detection, static and
conditional Browser fetching, cancellation, PageSpeed evidence support, and
S3-compatible object storage.

The source PostgreSQL storage and business-profile AI writer paths were not
imported. The adapted Worker has no database dependency, role, schema,
credential, or SQL write path. This is stricter than limiting writes to the
`crawling` schema and matches the accepted Temporal registry contract
`databaseAccess: none`.

## Executable Temporal Contract

| Contract | Executable value |
|---|---|
| Task Queue | `growthos.crawling.v1` |
| Workflow | `crawlingEvidenceV1Workflow` |
| Activity | `crawlingCollectEvidenceV1` |
| Pause signal | `crawlingPauseV1` |
| Stop signal | `crawlingStopV1` |
| Progress query | `crawlingProgressV1` |
| Object prefix | `crawler/<organizationId>/<websiteProjectId>/<runId>/` |

The Activity reports progress through Temporal heartbeats. Pause and stop
signals cancel the current Activity and return a versioned cancelled evidence
result. Activity retry is bounded to three attempts.

## Evidence And Storage Boundary

`crawler.evidence.v1` carries observed pages, contacts, backlinks, technical
values, safety decisions, redirect chains, resolved IPs, render mode, robots
decision, `noindex`, errors, and artifact references. It does not contain or
write final Project health, Audit conclusions, Opportunity, Placement,
recommendation, contact-purpose inference, lifecycle state, or `lost`.

The evidence policy is `safefetch.gold.v1`. Page bodies are stored as
deterministically keyed gzip artifacts. The Worker also stores
`crawl-result.v1.json` and `evidence.v1.json`. Every artifact reference contains
its key, URI, content type, encoding, byte size, and SHA-256 digest. The stable
request-derived Run ID and replacement-by-key reference tracking make retries
reuse the same keys and hashes rather than append duplicate domain writes.

## Safety And Rendering

- SafeFetch rejects unsupported schemes, URL credentials, nonstandard ports,
  ambiguous numeric hosts, private IPv4/IPv6, and DNS rebinding.
- Every redirect is validated and recorded before a rejected hop returns.
- Fetching enforces content-type and response-size limits.
- Robots rules, request spacing, concurrency limits, and context cancellation
  remain active.
- Static HTTP is the default. Browser execution is disabled by default and is
  used only when both configuration and task rendering policy allow it.
- Browser navigation, subresources, and final URLs pass the same public-target
  safety checks.

## Verification

| Command or gate | Result |
|---|---|
| Test-first `go test ./...` | Failed as expected before target Temporal/evidence implementation existed |
| Pinned Go `go test ./...` | Passed: crawler and Worker packages |
| Pinned Go `go test -race ./...` | Passed: crawler and Worker packages |
| Pinned Go `go vet ./...` | Passed |
| Pinned Docker builder target | Passed and produced the Crawler binary |
| SafeFetch/redirect/size/robots/rate/cancel/browser tests | Passed |
| Temporal namespace/pause/stop/query tests | Passed |
| Artifact hash/ref and retry stability tests | Passed |
| Shared contract tests | `4 passed` |
| Shared repository contract checker | 34 paths, 38 operations, one cross-module command, one cross-module result, four queues |
| Full FastAPI tests | `28 passed, 1 skipped` |
| Ruff | Passed |
| Static database/business-write scan | No Crawler database, SQL, final-state, or `lost` write path found |

The final Go runs used the pinned
`golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d`
container because no local Go toolchain is installed.

## Evidence Status

- `PROVEN`: repository implementation and disposable test execution.
- `PROVEN`: evidence-only contract, deterministic object refs, Browser default
  off, and zero database access.
- `UNKNOWN`: deployed Temporal namespace, active production poller, production
  S3-compatible object store, production network policy, and product E2E.
- `UNKNOWN`: authenticated external owner approval and named `ROLE-CRAWLER`
  staffing.

## Gate And Next Task

`SEO-V4-CRAWLER-GATE = PASS`. This clears the crawler-specific prerequisite
recorded for the Assessment phase.

The next prescribed task at this integration point is `BL-AI-081`. It was not
executed by this task.
