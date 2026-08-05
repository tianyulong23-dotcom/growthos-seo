# PB-F-METRICS-GOV Result

Status: INTEGRATED
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`
Handoff updated at: 2026-07-30
Task: `BL-AI-161..176`

## 2026-07-30 Integration Controller Acceptance

`BL-AI-161..176 = INTEGRATED`.

- Registered the exact `0030` and `0031` migration checksums in the protected
  deployment manifest and advanced the Backlinks migration head to `0031`.
- Extended the PostgreSQL 18 clean-install and historical-upgrade runner through
  `0031`. PostgreSQL `18.4` clean install, upgrade compatibility, DataForSEO
  writes, backup/restore, database contracts, and RLS all passed.
- Registered the existing Metrics Dashboard, published Reports, asynchronous
  Export, and versioned Settings routes in the shared Fastify private server
  and public FastAPI Gateway.
- Re-froze the shared Backlinks OpenAPI at 45 paths and 46 operations, and the
  aggregate Platform OpenAPI at 67 paths and 72 operations.
- The combined PB-D/PB-E/PB-F immutable-fact and PostgreSQL acceptance passed
  6 files and 35 tests. Links source contracts passed 5/5.
- `npm run verify:backlinks` passed: Unit 70 files/389 tests, API 30 files/86
  tests, Contract 20 files/144 tests, Integration 46 passed files plus 4
  environment-gated skips with 165 passed tests and 13 skipped tests, Security
  9 files/102 tests, and Resilience 3 files/8 tests.
- Full FastAPI passed 34 tests with 1 environment-gated skip and full Ruff
  passed. Frontend typecheck, lint with one existing non-blocking Reports Hook
  warning, production build, and Links source contracts passed. Pinned Go
  `1.25.4` Crawler test, race, and vet passed.
- PB-D Draft approval remains reconstructible from immutable facts; AUTO and
  MANUAL Reply assignment retain the same fact contract. Every completed
  Monitoring Observation retains exactly one immutable decision fact, and
  historical `suspected_lost` replay uses its captured policy thresholds.
- Browser remains default-off. No second Browser Worker, Queue, Launcher, or
  network stack was created. DataForSEO remains unchanged.
- No real Browser, Provider, DataForSEO, production database, commit, or push
  was used. `BL-AI-179` was not started.

## 2026-07-29 BL-AI-169..176 Execution

`BL-AI-169` through `BL-AI-176` are complete inside the PB-F boundary.
`BL-AI-179` was not started.

### BL-AI-169 asynchronous Export Workflow

- Added a persisted Export Workflow with `queued`, `running`, `completed`,
  `failed`, and derived `expired` states.
- The request path only persists and enqueues work; rendering never blocks the
  API request.
- Completed exports retain a private object reference, checksum, content
  metadata, storage policy version, and expiry time. The API never returns the
  private storage key.
- Download requires project scope plus actor authorization. Expired exports
  are inaccessible and cannot be re-authorized.

### BL-AI-170 Task and Notification Projection

- Added deterministic Task/Notification projection logic rebuilt from
  immutable lifecycle and workflow occurrence facts.
- Lost Placement, completed Export, and Reply assignment occurrences have
  stable deduplication keys, so replay does not duplicate projections.
- Notification read state is stored separately and cannot alter source facts
  or projection identity.
- Added forward-only `0031_backlink_tasks_notifications.sql` with
  project-scoped Task, Notification, and user read-state tables, occurrence
  uniqueness, RLS, forced RLS, and restricted grants.
- Migration SHA-256:
  `d7d0ddefab7667a3ec451ff6bf4825ba66d120da969b243b72be627fac27769a`.

### BL-AI-171 versioned Settings

- Added append-only Settings versions with `ExpectedVersion` conflict
  detection.
- A running Job binds the Settings version at startup; later Settings updates
  do not mutate the Job's effective version.
- Settings API reads and writes versioned report timezone, lookback, and
  export expiry values.

### BL-AI-172 layered Kill Switch

- Added deterministic precedence:
  Global, Organization, Workspace, Project, then Provider.
- A parent block cannot be overridden by a child allow.
- Missing authority or missing configuration fails closed.
- The feature API only permits Project and Provider layer changes and requires
  the exact `CONFIRM DANGEROUS CHANGE` confirmation.
- DataForSEO is a valid Provider target without changing DataForSEO code or
  provider behavior.

### BL-AI-173 Retention selector

- Added a selector-only Retention policy.
- Legal hold, audit records, lifecycle records, and active suppressions are
  excluded from eligible deletion records.
- Selection does not delete on a read path and has no production side effect.

### BL-AI-174 resumable Project deletion

- Added a persisted phase machine:
  `requested -> jobs_stopped -> tokens_revoked -> facts_deleting ->
  objects_deleting -> completed`.
- Jobs are stopped and provider tokens are revoked before fact or object
  deletion starts.
- Batch cursors and completed phases are persisted so retries resume instead
  of restarting destructive work.

### BL-AI-175 backup/restore validation

- Added temporary-database-only backup/restore validation with migration-head,
  key-count, RPO, and RTO checks.
- Added
  `PB-F-METRICS-GOV-backup-restore-runbook-draft.md`; it targets PostgreSQL
  custom-format backup, temporary restore, migration head `0031`, count
  validation, RPO no greater than 60 minutes, and RTO no greater than 4 hours.
- No production database, production backup, or destructive production
  operation was used.

### BL-AI-176 minimal observability

- Added OpenTelemetry spans and counters for Job, Workflow, and Provider
  correlation.
- Attributes are restricted to a fixed allowlist. Unknown attributes and
  email-like keys are rejected.
- Tokens, authorization codes, message bodies, provider payloads, raw
  responses, and error details are not recorded.

### Report read surface for frontend handoff

- Added a project-scoped published Report Revision query and module-local
  `GET /api/v1/projects/:websiteProjectKey/backlinks/reports` route.
- The route returns immutable input Snapshot IDs, Metric Definition versions,
  query/payload checksums, source watermark, generated time, and server-derived
  freshness.
- Shared server and shared OpenAPI registration remain integration-controller
  actions.

### RED / GREEN

- RED: eight targeted backend suites failed because Export Workflow,
  Task/Notification projection, Settings governance, deletion, restore
  validation, observability, and their APIs did not exist.
- RED: the PostgreSQL `0031` migration test and published Report Overview route
  test failed before their schema/route existed.
- GREEN: targeted backend tests pass, including real PostgreSQL
  Task/Notification migration coverage.
- `npm run typecheck` - PASS.
- `npm run lint -- --quiet` - PASS.
- `npm run test:backlinks:unit` - PASS, 70 files and 389 tests.
- `npm run test:backlinks:api` - PASS, 30 files and 86 tests.
- `npm run test:backlinks:contract` - PASS, 20 files and 144 tests.
- `npm run test:backlinks:integration` - PASS, 46 files passed and 4 skipped;
  165 tests passed and 13 explicit environment-gated tests skipped.
- `npm run test:backlinks:security` - PASS, 9 files and 102 tests.
- `npm run test:backlinks:resilience` - PASS, 3 files and 8 tests.
- `npm run dependencies:allowlist` - PASS.
- `npm run licenses:check` - PASS, 642 packages.
- `npm run source:manifest:check` - PASS, 26 records.
- `npm run openapi:backlinks:check` - PASS, existing shared baseline remains
  38 paths.
- `git diff --check` - PASS; it emitted only unrelated existing line-ending
  warnings.
- `npm run migration:backlinks:check` - expected shared-integration failure:
  the deployment manifest is missing `0030_backlink_metrics_reports.sql` and
  `0031_backlink_tasks_notifications.sql`, and still has a head older than
  `0031`.

### Integration handoff

The integration controller must:

1. Register the exact `0030` and `0031` checksums in the shared deployment
   manifest and advance the Backlinks head to `0031`.
2. Compose the module-local Dashboard, published Reports, Export, and Settings
   routes into the shared server and shared OpenAPI through their owners.
3. Wire the PB-FE Reports/Settings workspaces into protected navigation and
   page composition without changing the frozen DTO semantics.
4. Execute the temporary PostgreSQL backup/restore runbook after shared
   migration wiring.

No shared Event/OpenAPI/Temporal file, Coding State, protected frontend shell,
Crawler, DataForSEO implementation, Canonical State, or earlier migration was
modified. No real provider, production database, commit, or push was used.

HANDOFF_READY

## 2026-07-29 BL-AI-162..168 Execution

`BL-AI-162` through `BL-AI-168` are complete inside the PB-F boundary. No
`BL-AI-169` work was started.

### BL-AI-162 Metric and report persistence

- Added forward-only `0030_backlink_metrics_reports.sql` with immutable,
  project-scoped `backlink_metric_snapshots` and
  `backlink_report_revisions`.
- Added the mutable `backlink_report_publications` pointer so a successful new
  Revision can become current without rewriting prior report output.
- Snapshot identity includes Metric Definition version, Snapshot version,
  reporting window, `as_of`, Workspace IANA timezone, dimensions, source fact
  range/IDs/watermark, and deterministic input/result checksums.
- Snapshot and Revision rows reject `UPDATE` and `DELETE`; all three tables
  have enabled and forced RLS. The writer is append-only for Snapshot/Revision.
- Migration SHA-256:
  `f0c3a2053b79d1e358f5737b3d530af25548c8bc40f37bcc415e87b55f0d648f`.
- `0031_backlink_tasks_notifications.sql` was not created or started.

### BL-AI-163 deterministic Snapshot Builder

- Added canonical JSON/SHA-256 input hashing and a deterministic builder.
- A replay with the same facts, definition version, scope, window, timezone,
  and dimensions returns the existing Snapshot.
- A late immutable fact appends the next Snapshot version and preserves the
  prior result.
- Facts must match a source and contract version frozen by `BL-AI-161`.
  `backlink_placement_candidates` is rejected explicitly and cannot
  contribute to a successful Placement KPI.

### BL-AI-164 Dashboard Summary/Trend API

- Added a module-local strict Fastify route and read query for
  `/api/v1/projects/:websiteProjectKey/backlinks/metrics/dashboard`.
- The contract requires explicit `from`, `to`, `asOf`, and IANA `timezone`;
  it enforces `from < to <= asOf`.
- SQL filters by exact Organization, Workspace, Website Project, timezone,
  and requested window, selecting only the latest Snapshot version for each
  Metric Definition/window/dimension identity.
- Empty data is stable, and route plus PostgreSQL tests cover project
  isolation.
- The shared private server and frozen shared OpenAPI were not modified; route
  composition remains an integration-controller action.

### BL-AI-165 Report Revision Workflow

- Every generation requires unique explicit input Snapshot IDs.
- Loaded Snapshots must be complete and remain inside the exact project scope.
- A report cannot mix Definition versions for the same metric.
- Rendering completes before publication. A generator failure cannot replace
  the last published Revision.
- Publication receives the expected prior Revision number for repository-level
  compare-and-swap handling.

### BL-AI-166 CSV export

- Added streaming UTF-8 CSV with a BOM by default.
- Spreadsheet formulas beginning with `=`, `+`, `-`, or `@`, including after
  leading whitespace/newlines, receive an apostrophe prefix.
- Duplicate/blank columns and sensitive export column names are rejected
  before output starts.

### BL-AI-167 XLSX export

- Added an Adapter contract restricted to an injected
  `EXCELJS_ISOLATED_WORKER` runtime; ExcelJS is not loaded in the Core API
  process.
- Rows are consumed through an iterable/async-iterable streaming path.
- Row count, cell character count, estimated input bytes, and final output
  bytes are bounded. The same formula and sensitive-column defenses as CSV
  run before the isolated writer receives cells.
- Limit, invalid output, or writer failure aborts the workbook and does not
  commit a result.
- No dependency or shared package file was changed. Providing the actual
  isolated ExcelJS worker runtime remains downstream integration work.

### BL-AI-168 conditional PDF contract

- Added a self-contained, escaped A4 HTML report template.
- Added a default-off PDF Adapter with explainable
  `PDF_EXPORT_DISABLED` and `PDF_RENDERER_UNAVAILABLE` states.
- Enabled rendering requires an injected `ISOLATED_PDF_WORKER`, enforces an
  HTML byte limit, and validates the returned PDF signature.
- No Browser, Placement Browser fallback, external resource, or synchronous
  Browser startup dependency was introduced.

### RED / GREEN

- RED: seven targeted suites failed because the Snapshot Builder, report
  workflow, Dashboard route/query, CSV/XLSX/PDF adapters, and `0030`
  persistence modules did not exist.
- GREEN: all seven targeted files pass, 21 tests total.
- PostgreSQL `0030` test: PASS, 5 tests covering append-only versions,
  Dashboard latest-version/project isolation, immutable Revisions,
  publication movement, RLS, and writer privileges.
- `npm run typecheck` - PASS.
- `npm run lint` - PASS.
- `npm run test:backlinks:unit` - PASS, 66 files and 382 tests.
- `npm run test:backlinks:api` - PASS, 27 files and 83 tests.
- `npm run test:backlinks:contract` - PASS, 20 files and 144 tests.
- `npm run test:backlinks:integration` - PASS, 45 files passed and 4 skipped;
  162 tests passed and 13 explicit environment-gated tests skipped.
- `npm run test:backlinks:security` - PASS, 8 files and 100 tests.
- `npm run test:backlinks:resilience` - PASS, 2 files and 6 tests.
- Sensitive export-field scan - PASS.
- `npm run openapi:backlinks:check` - PASS, existing shared baseline remains
  38 paths.
- `npm run source:manifest:check` - PASS, existing manifest remains 26
  records.
- `npm run migration:backlinks:check` - expected integration failure only:
  the shared deployment manifest does not yet list
  `0030_backlink_metrics_reports.sql` and still declares `0029` as head.

The first parallel full-suite attempt caused unrelated existing 5-second Unit,
API, and Contract test timeouts under CPU contention. All three suites passed
when rerun serially; there were no assertion regressions.

### Integration handoff

The integration controller must:

1. Add the exact `0030` checksum above to the shared deployment manifest and
   advance the Backlinks head to `0030`.
2. Compose the module-local Dashboard route into the shared server/OpenAPI
   only through the shared-contract owner.
3. Connect an isolated ExcelJS worker if XLSX is enabled; keep the PDF switch
   off until an isolated renderer is deliberately integrated.
4. After shared migration wiring, run PostgreSQL 18
   clean/upgrade/backup/restore verification.

No shared Event/OpenAPI/Temporal file, Coding State, frontend, Crawler,
DataForSEO, Canonical State, package file, or earlier migration was modified.
No real provider, production database, commit, or push was used.

HANDOFF_READY

## 2026-07-29 BL-AI-161 Re-execution

`BL-AI-161` is complete. The prior prerequisite blockers have been replaced by
integrated immutable facts:

- Draft approval emits `draft.approval.recorded` with
  `draft-approval-fact.v1`, approved Draft Version identity, previous/next
  status, business occurrence time, and aggregate versions.
- Send success is reconstructed from terminal `PROVIDER_ACCEPTED` Send Attempt
  facts and append-only `PROVIDER_ACCEPTED` Send Reconciliation facts,
  deduplicated by Send Intent.
- AUTO and MANUAL Reply assignment both emit `reply.assignment.recorded` with
  `reply-assignment-fact.v1`; valid-human qualification uses immutable Reply
  Classification Versions.
- Successful Placement starts only at `placement.confirmed`. Placement
  Candidates are explicitly ineligible for successful Placement KPI counts.
- Every completed Monitoring observation emits
  `placement.monitoring.status_decided` with
  `placement.monitoring.status-decision.v1`, including previous/next status,
  policy version, confirmation thresholds, reason, and business occurrence
  time.

### Frozen metric contract

Added `domain/metrics/definitions.ts` with
`backlink-metric-definition.v1`. The registry fixes these V1 definitions:

1. `draft_approval_count`
2. `send_count`
3. `reply_rate`
4. `negotiation_conversion_rate`
5. `link_acquisition_rate`
6. `gained_placement_count`
7. `active_placement_count`
8. `suspected_lost_placement_count`
9. `lost_placement_count`
10. `recovered_placement_count`

Every definition fixes:

- immutable Fact/Lifecycle Event sources and business-time fields;
- numerator, denominator, deduplication key, and null result for a zero rate
  denominator;
- `[start, end)` local interval/cohort boundaries and inclusive `as_of`;
- UTC source timestamps and Workspace IANA reporting timezone, with browser
  timezone forbidden;
- `metric_key.v1` definition version;
- allowed dimensions;
- late-data recomputation and append-only correction revision rules.

No metric reads frontend state or a mutable Draft, Reply, Opportunity,
Placement Candidate, or Placement projection. Local day-end Placement status
is rebuilt by folding `placement.confirmed` and
`placement.monitoring.status_decided`.

Recommendation and Task metrics were not invented in this task because their
complete immutable source contracts are outside the explicitly confirmed
Draft, Send, Reply, Placement, and Monitoring prerequisite set. Adding a new
formula later requires a new metric definition version; it must not change
these V1 meanings in place.

### RED / GREEN

- RED: `npx vitest run test/unit/metric-definitions.test.ts` failed because
  `domain/metrics/definitions.js` did not exist.
- GREEN: the same test passed, 1 file and 5 tests.
- `npm run typecheck` - PASS after replacing an unsafe array-index source
  lookup with named immutable source constants.
- `npm run lint` - PASS.
- `npm run test:backlinks:unit` - PASS, 63 files and 375 tests.
- Targeted metric/fact/policy tests - PASS, 3 files and 22 tests.
- Targeted Draft/Send/Reply/Monitoring persistence integration tests - PASS,
  4 files and 35 tests.

### Boundaries

- Changed only `domain/metrics/definitions.ts`, its unit test, and this PB-F
  result file.
- No shared Event/OpenAPI/Temporal file, frontend, Crawler, DataForSEO,
  Canonical State, migration, schema, API, or projection was changed.
- `BL-AI-162` was not started.
- No commit or push was performed.

HANDOFF_READY

## Historical Blocked Audit (Superseded on 2026-07-29)

The remainder of this section records the pre-implementation audit only.
References to "current" or "next" below are historical and do not override the
`HANDOFF_READY` status or the completed `BL-AI-161..176` execution above.

The requested sequence was:

```text
PB-F public DTO freeze -> BL-AI-177 -> BL-AI-178
```

The public DTO freeze did not pass its prerequisite gate. A fresh source audit
confirmed that the three immutable-fact gaps recorded below still exist:

- Draft approval still updates `backlink_email_drafts.approved_version_id` and
  `status` in place.
- Automatic Reply assignment still updates
  `backlink_reply_match_candidates.requires_manual_confirmation` and
  `backlink_inbound_messages.match_status` without an append-only assignment
  fact shared by automatic and manual matches.
- Monitoring can project `suspected_lost`, but the immutable lifecycle stream
  only records confirmed/changed/lost/recovered/restored transitions and does
  not preserve the decision thresholds needed for historical replay.

The current frozen Backlinks OpenAPI remains valid at 38 paths and contains no
Metrics, Reports, Export, Settings, Kill Switch, or Retention public path.
Creating those DTOs now would assign semantics and server states that cannot be
rebuilt from the integrated immutable facts. No DTO or OpenAPI file was
changed.

Because the first gate failed, `BL-AI-177` and `BL-AI-178` were not started.
See `PB-FE-REPORTS-result.md` for the downstream handoff.

### Scope

- Read V1.4.1 `00` control index and `07-PB-F-METRICS-GOV`.
- Read the V1.0 `BL-AI-161` task card and the current Coding State.
- Audited whether Draft, Send, Reply, Placement, and Monitoring provide the
  immutable facts/Event Contracts required to freeze metric definitions,
  denominators, windows, timezone handling, and versions.
- Did not start `BL-AI-162`.

### Prerequisite Audit

| Domain | Integrated/frozen evidence | BL-AI-161 result |
| --- | --- | --- |
| Draft | Draft Version and Evidence Snapshot rows are immutable. | BLOCKED for current/approved Draft metrics. Approval is only an update of `backlink_email_drafts.approved_version_id` and `status`; no append-only approval/status fact or Event was found. |
| Send | Terminal Send Attempt facts and immutable Send Reconciliation facts retain `send_intent_id`, provider acceptance, provider thread identity, and business time. | READY. `send_count` can deduplicate accepted delivery facts by Send Intent and use `completed_at` or `reconciled_at`. |
| Reply | Reply Classification Versions and Negotiation Fact Versions are append-only and immutable. | BLOCKED for valid-human Reply and negotiation conversion denominators. Automatic matching updates `backlink_reply_match_candidates.requires_manual_confirmation` and `backlink_inbound_messages.match_status`; only manual confirmation writes `reply_match_candidate.confirmed`. There is no immutable automatic Reply-to-Opportunity assignment fact/Event. |
| Placement | Confirmed Placement and Placement lifecycle facts are integrated. Coding State records Candidate KPI count `0` and Candidate exclusion from successful KPI counts. | READY for confirmed/gained/lost/recovered Placement metrics. A successful Placement numerator must originate from a promoted Placement fact or `placement.confirmed`; a Placement Candidate is never eligible. |
| Monitoring | Monitor Observations are immutable and lifecycle Events exist for confirmed, changed, lost, recovered, and restored transitions. | BLOCKED for historical `suspected_lost` day-end reconstruction. The workflow does not emit a lifecycle Event for `suspected_lost`, while the confirmation thresholds needed to replay observations live on updateable `backlink_monitor_policies` rows and are not snapshotted into each Observation/Event. |

The Placement monitoring request/lifecycle Event Contracts are integrated and
frozen in the shared registry, but the missing Draft approval, automatic Reply
assignment, and `suspected_lost` decision facts mean that the complete metric
contract required by `BL-AI-161` is not reconstructible from immutable facts
and Events alone.

### RED / GREEN

#### RED

The definition gate was evaluated against the V1.0 acceptance rule:

> Every metric must be reconstructible from fact events, with no ambiguous
> success rate.

RED remains because these required semantics have no immutable denominator or
historical state source:

1. Current/approved Draft count.
2. Valid-human Reply rate and Opportunity-level negotiation conversion for
   automatically matched replies.
3. Placement `suspected_lost` day-end count under the exact historical policy
   thresholds.

#### GREEN

Not entered. Adding a metric registry that reads the mutable Draft aggregate,
Reply match projection, current Placement projection, or frontend state would
violate the task's acceptance rule. Inventing new facts, Events, or shared
contracts would also exceed the `BL-AI-161` allowed-file boundary.

### Minimum Unblock Contract

Resume `BL-AI-161` only after the owning blocks integrate and freeze:

1. An append-only Draft approval/status-transition fact with Draft ID, Draft
   Version ID, previous status, next status, occurred time, and contract
   version.
2. An append-only Reply assignment fact for both automatic and manual matches,
   carrying Inbound Message ID, provider/mail Thread identity, Opportunity ID,
   match authority, occurred time, and contract version.
3. An immutable Monitoring status-decision fact for every projected status,
   including `suspected_lost`, with Observation ID, previous/next status,
   policy version, loss/change thresholds, occurred time, and contract version.

These contracts must be supplied by their owning Draft, Reply, and Monitoring
blocks. PB-F must not add them through a metric-specific shadow event.

### Verification

- `npm run typecheck` - PASS on 2026-07-29.
- `npm run lint` - PASS on 2026-07-29.
- `npm run test:backlinks:unit` - PASS on 2026-07-29, 61 files and
  368 tests.
- `npm run openapi:backlinks:check` - PASS on 2026-07-29, 38 paths.
- Parsed `backend/contracts/openapi/backlinks.v1.json` - 38 paths, zero paths
  matching Metrics, Reports, Export, Settings, Retention, or Kill Switch.
- `npm run test:unit` - not a repository script; no test gate was inferred from
  this command.
- `npm run unit` - not a repository script; the declared
  `test:backlinks:unit` command above was run instead.

The passing existing gates verify the integrated fact implementations remain
green; they do not convert the failed `BL-AI-161` reconstructability
prerequisite into a GREEN result.

### Boundaries

- No shared Event/OpenAPI/Temporal file changed.
- No frontend, Crawler, DataForSEO, Canonical State, migration, schema, API, or
  business implementation changed.
- No production resource, real provider, commit, or push was used.
- Next executable PB-F task remains `BL-AI-161`; `BL-AI-162` was not started.
