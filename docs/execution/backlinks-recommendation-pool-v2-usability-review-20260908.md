# V2 Recommendation Pool Usability Review

Date: September 8, 2026. Scope: current local seven-project product.

## Decision

Gate 7's two bounded real latency baselines passed. The recommendation pool
is V2-only at the verified runtime boundary, but is **NOT READY** for an
unqualified production-quality or "smoothly usable" claim.

This review uses existing persisted facts, authenticated feed/release GETs,
the real browser UI and shared source inspection. It did not send outreach,
buy metrics, invoke AI/browser providers or manufacture candidate data.
The two Gate 7 runs cost USD 0.0048 in total under a USD 0.10 ceiling;
paid capability was disabled again after their terminal completion.

## Current Evidence

Read-only snapshot: 2026-09-08T02:34:49Z, with later runtime shutdown checked
at 02:44 UTC. Feed and release status are HTTP 200 for all seven projects.
V2 verification: 7 eligible, 7 valid V2 active, 0 migration-blocked, 0 active
V1 work, 18 immutable-history freeze triggers and 13 V1 history records.

| Project | Visible rows | Email present | PUBLIC_EMAIL_FOUND but no email | CONTACT_FORM_ONLY but no URL |
| --- | ---: | ---: | ---: | ---: |
| mpa-americalatina.org | 10 | 5 | 0 | 3 |
| awolvision.com | 20 | 0 | 6 | 5 |
| elephtv.com | 10 | 2 | 0 | 1 |
| everycine.com | 26 | 0 | 7 | 5 |
| snapmaker.com | 20 | 4 | 0 | 3 |
| aiper.com | 15 | 3 | 0 | 1 |
| manitosilk.com | 19 | 3 | 0 | 2 |
| Total | 120 | 17 | 13 | 20 |

All 120 visible rows have `recommended=true`, `category=null` and null
traffic/rank/spam metrics. No next cursor remains. Missing metrics are
truthfully null rather than fabricated values, but the pool therefore
cannot support reliable metric comparison/filtering at present.
Email presence does not establish ownership, cooperation intent or
deliverability.

Each current release reports PUBLISHED but NOT_UNLOCKED, with an opportunity
threshold and future unlock timestamp. That is a release policy boundary,
not a failed provider job. Discovery PATHS_EXHAUSTED alone must not be used
to infer that all previously prepared batches are unavailable. Historical
UI text combined an elapsed countdown's "available now" text with an unmet
opportunity threshold; this needs state-specific wording, not a shorter
timeout or bypass of the release rule.

## Required Improvements

### P0: Actionable Contact Consistency

Shared paths:

- `backend/core/src/modules/backlinks/activities/contact-enrichment.activity.ts`
  (`inspectContactHtml`, persisted contact completion).
- `backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts`
  (terminal evidence synchronization and publication snapshots).
- `backend/core/src/modules/backlinks/db/repositories/recommendation-feed.repository.ts`
  (`mapItem`, immutable contact fields at release).

The HTML detector currently treats forms with an email input, textarea OR
submit button as potential contact forms. Generic signup/search/login
forms can therefore look like cooperation paths. Some published form-only
outcomes have no source URL. Historical missing-email rows also need an
evidence trace to distinguish projection loss, stale context and genuinely
missing validated candidates; do not assume one cause for all thirteen.

Remediation:

1. Validate actual contact/cooperation intent, exclude generic login/search/
   newsletter forms, and persist the page URL plus evidence lineage.
2. Enforce outcome/value invariants before publication: email-found requires
   an eligible email; form-only requires a supported actionable page URL.
3. Reconcile existing V2 projections forward through shared domain code.
   Preserve immutable V1 and released audit facts. Where evidence is absent,
   return an explicit missing/unknown outcome rather than invent a value.
4. Verify that a chosen recommendation reaches the normal opportunity and
   draft workflow with the same contact. Use fake-provider sends only;
   real Gmail remains unauthorized.

Acceptance: zero inconsistent outcome/value rows across all seven projects,
context/tenant isolation preserved, adversarial form fixtures pass, and
the original browser/API path plus adjacent opportunity regressions pass.
Start with existing HTML and database evidence: no new paid provider calls.

### P0: Real Recommendation Qualification

Shared path:
`backend/core/src/modules/backlinks/application/services/recommendation-pool-v2-candidate-admission.service.ts`,
especially `sourceEvidence` and `decisionFor`.

Source type currently provides broad relevance/evidence signals;
country-code presence supplies MARKET_LANGUAGE_MATCH; discovery backlink
evidence may supply COOPERATION_PATH; hardExclusionSignals is empty at this
call site. These do not independently verify an individual site's audience,
editorial fit or cooperation opportunity. All rows being recommended is
an audit warning, not proof that every one is irrelevant.

Remediation: evaluate candidate-specific topical relevance, market/language,
site role and evidence of a plausible outreach path. Distinguish direct
competitors, broad retail/social platforms, directories, publishers and
partners without a hardcoded project/domain exclusion list. Use explicit
RECOMMENDED / CANDIDATE / UNKNOWN / EXCLUDED semantics and explainable
evidence; sparse metrics must not become a positive quality signal.

Acceptance: create a reviewed multi-project gold set from existing rows,
including relevant publishers, unrelated sites, self domains, competitors
and large platforms. Freeze a labeling rubric before changing admission.
Measure false-positive and false-negative rates; require per-row evidence
and no known hard exclusions admitted. Do not invent a precision percentage
from the present 120 unreviewed rows. Reuse existing evidence first; any AI
classification or new paid enrichment requires its own bounded approval.

### P1: Metrics and Category Coverage

Trace candidate metric provenance, existing metric observations, snapshot
eligibility and feed projection before buying any data. The current metric
enrichment events count three persisted metric facts but do not imply
three known numeric values. Null is not zero and should not be silently
filtered or promoted as known quality.

Remediation: retain unknown/error/stale states with reason and observation
time; derive categories only from supported evidence; reuse eligible cached
metric facts, deduplicate domains across projects and fetch missing metrics
in bounded batches only after relevance qualification.

Acceptance: required fields are either usable values with source/time or
explicitly explained unavailability. Sorting/filtering/export agree with
the UI and cannot convert unknown to zero. Establish a justified coverage
target on the approved gold set before paid completion; do not promise
100% provider coverage or spend on every low-quality domain.

### P1: State Semantics and Throughput

Fix shared UI projection and wording:

- Distinguish discovery finished, contact PREPARING, published, time-locked,
  opportunity-locked and genuinely exhausted.
- During the new real contact runs the durable preparation was active while
  the observed generation tuple still showed IN_PROGRESS/PENDING/PENDING;
  align this projection with actual stage facts.
- Replace raw diagnostic reason codes in ordinary UI text with meaningful
  labels while preserving codes in diagnostics.
- Retire misleading legacy `recommendationQueueMs` semantics: seed staging
  includes user think time, not worker queuing. Use scheduled/start facts
  or a separately named staging duration.

Contact capacity is globally two. Measured capacity waits were 67.927 s and
54.840 s; retries wait 30 s. Keep robots/access controls and per-domain
politeness. Before raising concurrency, run no-paid local stress tests with
multiple projects, retrying sites, fairness and memory/CPU checks. The
5-second publication poll is already active on new histories and replay-safe.
Future provider diagnostics should persist individual submit/poll/get and
poll-sleep spans; current evidence labels the combined standard-task adapter
envelope and does not claim pure provider CPU time.

Acceptance: no contradictory release labels; stage projection matches DB
facts; switching project/unmounting cannot leak observations or cached rows;
Get More changes user release only and creates no provider ledger row.
Validate a full-size batch separately before treating the two small Gate 7
baselines as a general latency SLO.

## Budget Order

1. Shared contact invariants, evidence reconciliation, admission fixtures and
   UI semantic fixes using existing data: no paid discovery.
2. Multi-project quality review, fake-provider downstream acceptance and local
   capacity tests: no paid discovery or real sends.
3. Only then request a small bounded metric/enrichment budget for qualified
   missing evidence, with per-domain reuse and a stop condition.
4. Run a representative full-batch product acceptance and human UAT; do not
   substitute unit-test counts or V2-only routing for this acceptance.

No work from this improvement list is claimed implemented by this review.
The present task closed Gate 7 and assessed the pool; it did not silently
expand into paid enrichment or a recommendation-quality redesign.

## Evidence

Canonical Gate 7 evidence:
`docs/execution/backlinks-recommendation-pool-v2-fix-implementation-001.md`,
sections 73-74.

Machine-readable read-only audit, browser traces, histories, timing reports,
replays and final no-active-work/no-paid-capability evidence:
`.codex-checkpoints/BACKLINKS-RECOMMENDATION-POOL-V2-FIX-GATE-7-REAL-002/`.

Current evidence levels: IMPLEMENTED, TESTED, LOCAL_RUNTIME, REAL_PROVIDER
and two bounded SAMPLE_ACCEPTANCE baselines. Not DEPLOYMENT or HUMAN_UAT.
