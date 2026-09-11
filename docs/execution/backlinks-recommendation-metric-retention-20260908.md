# Recommendation metric retention repair

Date: 2026-09-08

## Scope and ownership

Repository: john3947-seo-main; branch: main.
Baseline HEAD: 7df8d48d088328bd79fb0a1afef364b17cc8b6af.
The workspace already contained extensive unrelated changes. They were preserved.

This repair touched:

- backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-source.ts
- backend/core/src/modules/backlinks/application/services/commercial-discovery-request.service.ts
- backend/core/src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts
- backend/core/test/unit/commercial-discovery-source.test.ts
- backend/core/test/unit/commercial-recommendation-discovery.service.test.ts
- backend/core/test/backlinks/integration/recommendation-pool-v2-phase4-canonical-batch.test.ts
- frontend/src/features/outreach/recommendations/recommendation-feed-workspace.test.tsx
- This evidence document.

No schema migration, historical release rewrite, paid collection, Gmail send,
or automatic resumption of historical sync jobs was performed.

## Changes

- Parse DataForSEO backlinks_spam_score alongside supported existing aliases.
- Preserve numeric zero and merge complementary duplicate-domain metrics instead
  of replacing all metrics when a later row has a higher rank.
- Retain adapter-returned provider response JSON in new discovery artifacts.
  Existing artifacts without rawResponse remain readable. The provider batch
  raw payload hash is computed from that response JSON.
- Publication prefers available, fresh metrics over newer unavailable snapshots.
  It can reuse earlier V2 snapshots for the same tenant, project and domain when
  market, location and language match. Observations must not be in the future
  and must be within seven days.
- Keep the original metric provenance and observation timestamp, including
  milliseconds. Expired or mismatched observations do not become known values.
- Preserve existing shared exact-request cache reuse.

These changes apply to subsequent ingestion and publication. Historical immutable
release items were not rewritten. Missing historical raw responses cannot be
reconstructed. Providers that did not return a metric still yield unknown values;
this repair does not add paid enrichment.

## Verification

- Core unit and contract suites: 213 files, 1456 tests passed.
- Focused core regression suite: 7 files, 75 tests passed.
- PostgreSQL canonical-batch and recommendation-feed integration suites:
  2 files, 10 tests passed. Covers parsing, persisted metric snapshots,
  previous-generation reuse, unavailable/stale/mismatched observations,
  release values and provenance.
- Frontend recommendation suites: 4 files, 25 tests passed, including rendering
  traffic 321, rank 45 and spam 0 without unknown placeholders.
- Core typecheck, build and focused ESLint passed.
- Scoped git diff --check passed with line-ending warnings only.

## Local runtime

API and Worker restarted with the existing manual-UAT configuration at
2026-09-08T14:15:35+08:00.

- Both report build local-product-2588f511e7d7d3c48e7552e1.
- Worker businessConsumersRunning: true.
- DataForSEO, browser, AI and Gmail remain configured and available.
- BACKLINKS_PROFILE_SYNC_MODE remains manual.
- The existing DataForSEO execution ceiling was not raised.
- Browser-authenticated ElephTV recommendation-feed GET returned HTTP 200,
  totalCount 25. Existing known metrics remain traffic 8, rank 10, spam 10.
  Zero spam is retained for infobelpro.com, amazon.com and github.com.
- Provider usage ledger count remained 273 before and after deployment.
- All four historical backlink_profile_sync jobs remain waiting_provider;
  their August 27 timestamps are unchanged.

Evidence level: implemented, tested and local runtime verified. No new
real-provider acceptance or hosted deployment is claimed.
