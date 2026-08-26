# BACKLINKS-CORE-REMEDIATION-PHASE-4 Result

## Start Card

- Task ID: `BACKLINKS-CORE-REMEDIATION-PHASE-4`
- Title: `Progressive V3.2 Candidate Qualification`
- Status: `INPUT_REQUIRED`
- Started: `2026-08-16`
- Updated: `2026-08-17`
- Authority:
  `docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`,
  Phase 4.
- Result artifact:
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-4-result.md`.
- Stop point: record the Phase 4 result and stop before Phase 5.
- User-visible recommendation model: `recommendation-commercial-fit.v3`.
- Active rule version: `recommendation-commercial-fit-rules.v3.2`.
- Explicitly excluded:
  - Phase 5 or later work.
  - Gmail send, draft, sync, or OAuth mutation.
  - Real paid AI calls.
  - Real Browser or SafeFetch calls.
  - Production deployment or production migration execution.
  - Commit, push, pull, merge, rebase, checkout, clean, or unrelated cleanup.

## Provider Ceiling

- Candidate domains: at most `25`.
- Paid DataForSEO calls: at most `3`.
- Per-call actual cost: at most `$1.00`.
- Total actual cost: at most `$1.00`.
- Estimated cost for three bulk calls: approximately `$0.07`.
- Stop immediately on `unknown_charge`; do not replay an ambiguous paid
  request.
- Reuse the same provider evidence for scoring and persistence.
- Paid AI, Browser/SafeFetch, and Gmail calls: `0`.

## V3.2 Product Rule

Candidates are excluded before scoring only when one of these gates is hit:

1. own or related domain;
2. existing backlink or existing cooperation opportunity;
3. permanently rejected or blocked domain;
4. zero product, topic, and keyword relevance;
5. unrelated industry;
6. unsafe or access-prohibited site;
7. PBN or link farm.

Country and language mismatch are not hard exclusions. They reduce the market
component and ranking priority while leaving the candidate usable when the
other gates pass.

The score is out of `100`:

| Component | Weight |
| --- | ---: |
| Product, topic, and keyword semantic relevance | 30 |
| Target audience and partnership-goal match | 15 |
| Country and language match | 15 |
| Site type and commercial cooperation suitability | 15 |
| DataForSEO authority and risk evidence | 15 |
| Traffic and search visibility | 5 |
| SafeFetch accessibility evidence | 5 |

Admission starts at `55`. If the evaluated batch produces no admitted
candidate, the same evidence is reused at `50`, `45`, `40`, and subsequent
five-point thresholds until a batch is found or the evidence is exhausted.
Threshold fallback does not remove any hard exclusion.

Fresh DataForSEO Traffic, Spam, and Rank values are evidence-only inputs. They
must not recreate the former V4 hard thresholds of Traffic `>=30000`, Spam
Score `<=10`, accessibility, or semantic score.

## Implemented

- Shadow and production qualification now persist the complete V3.2 source
  decision, including:
  - all seven weighted components;
  - hard-gate hits and missing-evidence reasons;
  - source decision and total score;
  - baseline and applied progressive-admission thresholds;
  - market/language tier and reason codes.
- The production qualification operation uses the
  `commercial-qualification-v3.2:<generation>` namespace.
- Candidate input is canonicalized, deduplicated, deterministically ordered,
  and limited to `25` domains.
- A non-empty batch can issue exactly one governed Traffic request, one Spam
  request, and one Rank request.
- An empty batch returns `candidate_supply_required` without credential
  resolution, provider dispatch, or cost reservation.
- DataForSEO metrics are persisted as `freshMetricsRole: "evidence_only"`.
- Website Project and Resource Library candidates use the same V3.2
  qualification contract.
- The local runtime parser validates the complete V3.2 decision instead of
  reconstructing a V4 decision.
- Forward-only migration `0065` preserves historical V4 facts while allowing
  current V3.2 generation and qualification facts.
- Migration `0065` enforces the V3.2 evidence, component, rule, admission, and
  eligible-decision contract without applying historical V4 metric gates.
- `scripts/dev-up.ps1` and the deployment manifest now recognize migration
  head `0065`.

## Verification

### Focused Verification

- V3.2 Shadow, production, bulk-governance, request-governance, runtime, and
  Resource Library suites: `PASS`, `6` files and `32` tests.
- PostgreSQL recommendation-contract compatibility through `0065`: `PASS`.
- TypeScript typecheck: `PASS`.
- Focused ESLint: `PASS`.
- Migration manifest and checksum validation: `PASS`.
- `git diff --check`: `PASS` with Windows line-ending warnings only.

The focused tests include an eligible V3.2 candidate with Traffic `250`, Spam
Score `85`, and Authority Rank `5`. This proves those DataForSEO values remain
scoring evidence and are not hidden hard exclusions.

### Complete Serialized Gate

- Command:
  `$env:VITEST_MAX_WORKERS='1'; npm run verify:backlinks`
- Result: `PASS`.
- Static gates:
  - TypeScript: `PASS`.
  - ESLint: `PASS`.
  - Source manifest: `28` records, `PASS`.
  - Dependency allowlist: `PASS`.
  - Third-party licenses: `693` packages, `PASS`.
  - OpenAPI: `72` paths, `PASS`.
  - Migrations: `58` files through `0065`, `PASS`.
- Tests:
  - Unit: `745` passed.
  - API: `130` passed.
  - Contract: `185` passed.
  - Integration: `223` passed, `13` skipped.
  - Security: `110` passed.
  - Resilience: `8` passed.

## Local Runtime Evidence

- Runtime profile: `storage/runtime/m1c/seo-main-ui`.
- Platform API health: HTTP `200`.
- Backlinks Core API health: HTTP `200`.
- Backlinks worker health: HTTP `200`.
- Worker execution mode: `quiesced`.
- Frontend remains available on port `5173`.
- Active Website Project:
  `68299b17-33d6-4993-b106-cf24f1f880bc`.
- Project domain: `elephtv.com`.
- Country and language: `ZA`, `en`.
- Products: `直播`, `影视`.
- Target audience: `南非人`.
- Partnership goal: `获取权威影视评测网站的高质量外链`.
- The current stored project settings do not contain an explicit competitor
  domain. `smiletv.net` is therefore not claimed as persisted Phase 4 runtime
  evidence.

Tenant-scoped database inspection on `2026-08-17` found:

- provider requests: `0`;
- `unknown_charge` requests: `0`;
- provider usage-ledger rows: `0`;
- actual cost: `$0`;
- reserved cost: `$0`;
- commercial candidates: `0`;
- generation contracts: `0`;
- V3.2 qualification facts: `0`.

The recommendation inventory is still at generation `1` with an empty raw,
fit, and candidate-ready pool. The previously queued bootstrap job is not
executed because the worker is quiesced. Starting the complete refill workflow
would also invoke discovery and SafeFetch work outside this Phase 4 acceptance
scope.

The Resource Library contains active/imported supply, but no row currently
provides the complete, honest V3.2 critical evidence needed to create a
project-scoped commercial candidate. A Resource Library row is not manually
promoted merely to manufacture runtime acceptance.

## Evidence Classification

- Code and contract evidence: `PASS`.
- Static and PostgreSQL migration evidence: `PASS`.
- Local runtime health and zero-call behavior: `PASS`.
- Real non-empty DataForSEO qualification: `CANDIDATE_SUPPLY_REQUIRED`.
- Real DataForSEO calls: `0`.
- Actual and reserved DataForSEO cost: `$0`.
- Real Browser/SafeFetch: `NOT_AUTHORIZED`, `0` calls.
- Real paid AI: `NOT_AUTHORIZED`, `0` calls.
- Gmail: `NOT_AUTHORIZED`, `0` calls and `0` sends.
- Deployment and UAT: `NOT_RUN`.

## Input Required

The V3.2 implementation portion of Phase 4 is complete. The remaining runtime
acceptance requires at least one project-relevant candidate with genuine
evidence for the V3.2 critical inputs, including semantic relevance,
market/language status, site suitability, risk/authority evidence, and
SafeFetch accessibility.

The next authorized acceptance may either:

1. evaluate a bounded set from the Resource Library and collect the missing
   SafeFetch evidence; or
2. run a bounded discovery/evaluation slice that creates honest V3.2
   candidates.

After candidate supply exists, the already recorded ceiling of at most `3`
DataForSEO calls and `$1.00` total actual cost can be used for the non-empty
qualification acceptance. Any Browser/SafeFetch execution still requires
separate authorization because its current allowed call count is `0`.

## Stop

- Phase 4 stops as `INPUT_REQUIRED` only for non-empty live acceptance.
- Phase 5 and every later phase remain `NOT_AUTHORIZED`.
- No real provider call, production migration, Gmail action, repository
  history mutation, or unrelated cleanup was performed.
