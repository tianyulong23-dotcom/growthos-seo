# LOCAL-PRODUCT-015 Result

## Execution Result

- Status: `PASS_CODE_PROVIDER_INPUT_REQUIRED`
- Executed at: `2026-08-06 15:58:08 +08:00`
- Branch: `外链part`
- Baseline HEAD: `7cf0d479aee210d2d77c2fbad523958e9a78adca`
- Live paid provider calls in this execution: `0`
- Live paid provider cost in this execution: `0 micros`
- Stop boundary: `LOCAL-PRODUCT-016` was not executed.

The code, migrations, contracts, runtime wiring, frontend polling, Gold Set tooling,
and provider-disabled acceptance checks required by `LOCAL-PRODUCT-015` are
implemented and verified. The single bounded live DataForSEO batch was not run
because the active runtime allowlist has not yet been refreshed to the six
approved endpoints and the remaining workspace budget is below the observed
cost of one prior batch.

## Implementation Coverage

### A. Commercial Discovery Blueprint

- Added immutable, versioned commercial discovery blueprints associated with the
  active project context snapshot.
- Discovery uses project evidence and SafeFetch/static evidence before optional
  AI assistance.
- AI output is constrained by a strict Zod schema and has a deterministic
  fallback path.
- Competitor input is limited to observed competitors.
- Context replacement makes prior discovery state stale instead of silently
  treating it as current.

### B. DataForSEO Discovery Runtime

- Added a strict official DataForSEO adapter with endpoint allowlisting,
  request-intent validation, budget reservation, cache/idempotency handling,
  and normalized result handling.
- Approved endpoint set in code and configuration import defaults:
  - `/v3/serp/google/organic/task_post`
  - `/v3/serp/google/organic/tasks_ready`
  - `/v3/serp/google/organic/task_get/advanced`
  - `/v3/dataforseo_labs/google/competitors_domain/live`
  - `/v3/backlinks/competitors/live`
  - `/v3/backlinks/referring_domains/live`
- Added local normalization, deduplication, project-domain exclusion, and source
  provenance.
- Async provider failure is represented as paused/unavailable rather than
  fabricated success.
- Discovered candidates and evidence artifacts remain internal. Discovery does
  not publish a recommendation or email address.

### C. Static Assessment

- Added bounded SafeFetch/Cheerio/tldts assessment of candidate sites.
- Page fetches are capped and constrained by the existing network safety policy.
- HTTP 403, timeout, and insufficient evidence result in
  insufficient/manual-review states.

### D. Commercial Score v2

- Implemented deterministic weighted scoring:
  - topical relevance: `25`
  - authority/quality: `15`
  - traffic/evidence: `15`
  - link feasibility: `15`
  - commercial fit: `15`
  - contactability: `10`
  - freshness: `5`
- Added evidence gates, missing-evidence handling, and stable ordering.
- Email availability remains a separate publication gate and is not folded into
  discovery truth.

### E. Inventory and Publication

- Added independent inventory watermarks:
  - `candidateReady`
  - `publishedContactReady`
- Added automatic refill evaluation for low inventory, no in-flight refill,
  cooldown, and budget availability.
- Contact enrichment can use bounded overfetch without changing the candidate
  discovery count into an email-success count.
- Inventory pages are read-only projections of published state.
- Immediate inventory signals enter the existing durable refill workflow.
- New candidates remain internal and enter the next contact-processing stage;
  they are not automatically published.
- Public recommendation queries enforce:
  - `publication_status = PUBLISHED`
  - `verified_public_email_count >= 1`

### F. API, Contract, Client, and Frontend

- Added the Core and FastAPI Gateway route:
  - `GET /api/v1/projects/{websiteProjectKey}/backlinks/recommendation-inventory`
- Synchronized Backlinks OpenAPI, aggregate platform contract, and generated
  frontend client.
- Added recommendation inventory polling with a maximum visible polling window
  of 60 seconds.
- When the polling window ends, the UI displays the required text:
  `后台继续处理中`.
- Fixed legacy ElephTV context compatibility by resolving the latest active
  context snapshot UUID inside the inventory query instead of comparing UUID
  columns with the legacy text profile version.

### G. Persistence and Gold Set

- Added migration
  `0045_backlink_commercial_candidate_inventory.sql` and registered it in
  startup, deployment, contract, and migration verification paths.
- Added persistence for discovery blueprints, batches, candidates, evidence
  artifacts, inventory policies, Gold Sets, labels, and public inventory
  projection fields.
- Added Gold Set import/report tooling and metrics for:
  - Precision@20
  - duplicate rate
  - gate false-positive rate
  - Top-K Jaccard stability
  - cost per ready candidate
  - market coverage
- Production calibration remains gated until there are at least 500 labels and
  sufficient suitable/unsuitable/uncertain coverage per market. No production
  precision claim is made by this execution.

## Provider-Disabled Acceptance

The full local stack was restarted with paid providers disabled after the final
Gateway and legacy-context fixes.

| Component | Result |
| --- | --- |
| Frontend | `http://localhost:5173` returned HTTP 200 |
| FastAPI Gateway | `http://localhost:7200` returned HTTP 200 |
| Backlinks Core | `http://localhost:7301` returned HTTP 200 |
| Postgres | healthy; Backlinks migration `0045` active |
| Temporal | healthy |
| DataForSEO | disabled |
| AI provider | disabled |
| Gmail send/sync | disabled |
| Browser provider | disabled |

Final restart run: `20260806-155432`.

## AWOL and ElephTV Regression

### AWOL

- Project key: `awolvision-com-4ec81dca`
- Recommendation inventory endpoint: HTTP 200
- `candidateReadyCount`: `0`
- `publishedContactReadyCount`: `0`
- `historicalEmailHitRate`: `0.1`
- `refillInFlight`: `false`
- `pauseReason`: `null`
- Existing historical recommendations: `21`
- New commercial discovery candidates: `0`
- Commercial discovery batches: `0`
- Public recommendations returned: `0`

### ElephTV

- Project key: `elephtv`
- Recommendation inventory endpoint: HTTP 200
- `candidateReadyCount`: `0`
- `publishedContactReadyCount`: `0`
- `historicalEmailHitRate`: `0.1`
- `refillInFlight`: `false`
- `pauseReason`: `null`
- Existing historical recommendations: `20`
- New commercial discovery candidates: `0`
- Commercial discovery batches: `0`
- Public recommendations returned: `0`

The public results satisfy the publication/email hard filter. Existing
historical recommendations are not reported as newly discovered internal
candidates.

## Provider and Budget Audit

- Active worker setting: `DATAFORSEO_ENABLED=false`
- Configured maximum paid calls: `25`
- Credential reference configuration is present; the secret value was not read
  or persisted.
- Active runtime allowlist currently contains only the historical
  `/v3/backlinks/referring_domains/live` endpoint.
- Workspace budget limit: `100000 micros`
- Historical settled spend: `82800 micros`
- Reserved spend: `0 micros`
- Remaining budget: `17200 micros`
- Observed prior single-batch cost: `27600 micros`
- New DataForSEO requests since this execution began: `0`
- New DataForSEO ledger rows since this execution began: `0`
- New DataForSEO settled cost since this execution began: `0 micros`

The workspace has three historical settled ledger entries. The third entry is
an existing AWOL entry created on August 5, 2026; it was not generated by this
execution.

Because `17200 < 27600` and the active runtime allowlist is not yet the complete
approved set, a live paid batch would violate the gate. Fixtures verify adapter
behavior but are not presented as live provider evidence.

## Verification

| Check | Result |
| --- | --- |
| Focused commercial domain/service tests | 12 files, 35 tests passed |
| Scheduler/official adapter/Gold Set subset | 4 files, 9 tests passed |
| Local process/capability/runtime tests | 5 files, 53 tests passed |
| FastAPI Gateway tests | 19 passed |
| FastAPI Ruff check | passed |
| Recommendation route tests | 5 passed |
| Backend TypeScript typecheck | passed |
| Frontend TypeScript typecheck | passed |
| Recommendation frontend source tests | 2 passed |
| OpenAPI validation | passed; 58 paths |
| Frontend production build | passed; existing chunk-size warning only |
| Migration verifier | passed; 38 migrations through `0045` |
| PowerShell syntax validation | 6 files passed |
| Git whitespace check | no errors |

The final runtime check also confirmed that the new Gateway inventory route is
reachable and that the ElephTV legacy context no longer causes an HTTP 500.

## Required Provider Input

Before the one permitted live batch can be executed:

1. Refresh the DataForSEO configuration using the repository import flow so the
   active allowlist contains all six approved endpoints. Credentials must remain
   in the local secret flow and must not be pasted into chat or reports.
2. Increase or reset the workspace budget so at least `27600 micros` remains
   available for the bounded batch.
3. Start the provider-enabled runtime with a one-call ceiling and execute
   exactly one controlled live batch in the designated later live gate.

Until those inputs are supplied, the correct result is
`PASS_CODE_PROVIDER_INPUT_REQUIRED`.
