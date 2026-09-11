# Hybrid supply Phase 3 - 2026-09-10

## Execution boundary

- Task: HYBRID-SUPPLY-PHASE3.
- Authority: recommendation-pool-hybrid-supply-coding-plan-20260910.md, Phase 3.
- Result: this file. Stop before Phase 4 application enablement and acceptance.
- Provider ceiling: zero real Ahrefs, DataForSEO, AI or Gmail requests.
- No production migrations, source-library writes, service restarts, commit or push.
- Fixtures and isolated test databases are allowed.
- Repository: C:/Users/DELL/Documents/缝合/john3947-seo-main.
- Git: main, HEAD 7df8d48d088328bd79fb0a1afef364b17cc8b6af,
  origin https://github.com/john3947/seo.git. Existing dirty work is preserved.
- Ownership: batch allocation/finalization, hybrid supply reservation metadata,
  unlock policy and its forward migration, feed metric projection/pagination,
  corresponding contracts/generated clients and focused tests only.
- Historical cutover calls retain the V1 allocation/fingerprint policy.
- Contact preparation and its 24-hour deadline are unchanged.

## Baseline SHA256

Paths below are relative to this repository.

| File | SHA256 before Phase 3 |
| --- | --- |
| backend/core/src/modules/backlinks/domain/recommendations/recommendation-batch-policy.ts | 8EF9FB91E055733F7838CD1BAA9581A3327CA60ADA49A2E9800C17732A5D29DA |
| backend/core/src/modules/backlinks/domain/recommendations/recommendation-user-unlock-policy.ts | EA6D8007A131DA5876360E289EEBEA94D286619DD6AA7B22CD404B6E362AE642 |
| backend/core/src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.ts | 18D81E0608AA7B4156754DDAB27485F585E47294A51EE57B5AC6FD8E977BE8A9 |
| backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts | 2133776B836296F5FA5F2CA66704C859616B73467D1C25B7F722D9462DEE4B7B |
| backend/core/src/modules/backlinks/db/repositories/recommendation-feed.repository.ts | CB24CA083811A9816330E83F94171A7439E82DA707362C1FB9A81EFD2557761D |
| frontend/src/features/outreach/recommendations/recommendation-feed-workspace.tsx | DA6AF27DD3C3B3C219AED962252155C4798B130CEE4458F74B400D2F7C4EC62B |
| backend/database/deployment-manifest.v1.json | 33439DEAA7C9B4FE2B8133BE49A8EF588E0B503C992DA62AB853EEFC605ED81D |

## Checkpoints

1. Source-aware allocation and historical compatibility: PASS.
2. Database/backend unlock and state compatibility: PASS.
3. Feed pagination, metrics and frontend compatibility: PASS.
4. Focused tests and final evidence: PASS, with the unrelated lint baseline below.

IMPLEMENTED, TESTED, LOCAL_RUNTIME, REAL_PROVIDER and DEPLOYMENT are separate
evidence levels. No live completion claim is authorized by this phase.

## Implemented

- New native finalizations use `recommendation-batch-selection.hybrid.v2`.
  First two DFS portions use ceil/floor of min(DFS,200); each batch is at most
  100. Later batches consume remaining DFS before library candidates.
- Library matches retain their release batch ordinal in source evidence.
  A partial reserved library portion cannot steal another match's high-DR
  allowance. Older artifacts without this optional field still parse.
- Finalized generations reuse persisted batches; historical cutover callers
  retain the prior allocator and fingerprint implementation.
- Empty later generations check library supply before paid discovery.
  Insufficient partial admission rolls back before the existing bounded
  discovery path. Provider/library errors do not masquerade as exhaustion.
  Existing candidates, discovery request intents or round facts preserve the
  original discovery/resume path and settled-cost handling.
- Migration `0100_backlink_hybrid_batch_release.sql` adds the immutable
  library metric snapshot and replaces the SQL unlock eligibility function.
  `NO_GATE` requires zero Opportunities and no elapsed-time wait.
  Historical unlock reasons/thresholds remain valid immutable audit facts.
  Available/preparing/exhausted, tenant entitlement and idempotency guards remain.
- Feed/API defaults, frontend initialization and filter reset use 35 rows.
  Full-result filtering and contact-priority ordering precede pagination.
- Removed unlock countdown/progress helpers and UI. Generation progress remains.
- Library Ahrefs DR and monthly traffic are distinct from DFS Rank and organic
  ETV. Known zero is displayed; absent values remain unknown. Library-only
  candidates can finalize without fabricating DFS metrics.
- Regenerated Backlinks/platform OpenAPI and the existing frontend client.
  No Temporal workflow command sequence was changed.

## Regression Findings

- A new PostgreSQL 100-item test reproduced default-sort pagination dropping
  rows after page one: JavaScript Date truncated the publication timestamp
  from microseconds to milliseconds. The cursor now retains the database's
  full precision. The same path passes 35/35/30 with 100 unique item IDs and
  unchanged side-effect counts.
- The new optional reservation field initially broke strict parsing of older
  library artifacts. Required-key validation now includes it only when present;
  all five legacy library-admission tests pass.
- Historical canonical test expectations were updated from five 6/6/6/6/2
  batches to two 13/13 batches for 26 DFS candidates. Both batches are prepared,
  and recovery is idle after the final batch; no synthetic third batch is made.

## Verification

All commands ran locally with fixtures or isolated PostgreSQL containers.
Integration commands used `NODE_OPTIONS=--dns-result-order=ipv4first`.

| Evidence | Result |
| --- | --- |
| Backend allocation/unlock/supply/activity/feed unit tests, API routes and Temporal historical replay | 101 tests, 12 files PASS |
| Feed PostgreSQL integration: historical reads, default pagination, full-result filtering, entitlement, immediate get-more and idempotent replay | 9 tests PASS |
| Canonical PostgreSQL integration, DR cache integration, SQLite adapter, rating, runtime and library admission regressions | 69 tests, 6 files PASS |
| Frontend workspace/API/state/hook tests including DR zero and removed unlock controls | 27 tests, 4 files PASS |
| Total focused and adjacent regression evidence | 206 tests, 23 files PASS |
| Backend `npm run typecheck` | PASS |
| Frontend `npm run check:backlinks-v2-contract` | PASS |
| Backend `npm run openapi:backlinks:check` | PASS: 87 paths |
| API `scripts/check_shared_contracts.py` | PASS: 249 paths, 279 operations |
| Frontend `npm run check:backlinks-client` | PASS: 89 operations |
| Backend `npm run migration:backlinks:check` | PASS: 92 files through 0100 |
| Scoped source/new-test lint and frontend touched-file lint | PASS |
| Full backend lint | NOT CLEAN: 11 unrelated existing non-null assertions |

The full-lint exceptions are ten assertions in
`backend/core/test/backlinks/integration/project-context-projection-demand.test.ts`
and the pre-existing assertion at line 915 in
`backend/core/test/backlinks/integration/recommendation-feed-phase6.test.ts`.
They were not changed to make the overall repository appear clean.

The canonical integration applies the complete deployment manifest through
0100. The historical feed fixture uses its original 0093 baseline plus the
additive 0100 migration, so retired V1 fixture writes are not re-enabled in
production. Library snapshot mutation is rejected by the existing immutable
batch-item trigger.

## Stop Point And Handoff

- IMPLEMENTED: yes, Phase 3 only.
- TESTED: yes, evidence above; not a claim that the entire dirty repository passes.
- LOCAL_RUNTIME / real UI and API acceptance: not performed.
- REAL_PROVIDER / full source-library import: not performed.
- DEPLOYMENT / production migration / application restart: not performed.
- HUMAN_UAT: not performed.

Phase 4 must apply the approved migration sequence (including 0099/0100),
enable the existing resource-library configuration in the intended runtime,
and verify the actual application path within its authorized provider ceiling.
Do not deploy the new read queries against a database missing 0100.
Do not treat fixture success as live acceptance or send Gmail as part of this work.
