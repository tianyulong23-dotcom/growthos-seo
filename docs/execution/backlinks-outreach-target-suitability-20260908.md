# Backlink Outreach Target Suitability

Date: 2026-09-08

## Product Rule

Known general-purpose platforms, marketplaces, search engines, social networks,
and corporate product sites in `outreach-target-policy.v1` are not publisher
outreach inventory. This policy applies to every project and discovery source.
Root domains and subdomains match on label boundaries. A competitor backlink,
SERP appearance, contact address, positive relevance marker, or missing SEO
metrics does not override the exclusion.

The authoritative registry is
`backend/core/src/modules/backlinks/domain/recommendations/outreach-target-policy.ts`.
It includes Amazon country domains, Reddit, Apple, social/search platforms, and
marketplaces including Etsy. High Rank or traffic alone is NOT an exclusion:
legitimate high-authority publishers remain eligible under existing V2 rules.

This registry is deterministic, not a universal semantic classifier of unknown
businesses. New identities must be added to the shared registry with regression
coverage. A future verified placement-specific/self-service product must have an
explicit separate eligibility path; a platform homepage is not such evidence.

## Enforcement

- V2 candidate evaluation records `PERMANENTLY_EXCLUDED`, policy version,
  `NON_OUTREACH_TARGET`, and the matched domain in durable decision/exclusion
  evidence. Contact preparation is not required and recommendation is false.
- Canonical finalization first verifies complete persisted lineage, then applies
  the current policy before creating new batches. Old ADMITTED facts cannot
  bypass this check. The original completeness check remains intact.
- The shared feed SQL predicate filters list results, counts, batch/category
  options, filtered export, and selected-ID export.
- Opportunity creation from a feed item repeats the same policy check.
  Direct requests using an old item ID cannot create a new opportunity.
- Existing idempotency replays, opportunities, messages, and immutable historical
  release facts are preserved. No product database repair or destructive
  migration is used.

## Verification

- Unit suite: 186 files / 1,310 tests passed before the final 10-domain registry
  extension. Contract suite: 28 files / 203 tests passed.
- Final focused run: 84 tests passed, including the expanded registry, admission,
  and 12 PostgreSQL integration tests.
- PostgreSQL regression fixtures verify old admitted candidates cannot enter a
  new batch; historical list/count/export omit blocked domains; direct old-ID
  opportunity creation returns not_found; original audit items remain.
- Core TypeScript build and focused ESLint passed.
- API and worker both run `local-product-7bf5a7d414e8bd543816caf8`.
- Authenticated original Manito GET/UI: before 19 visible items, after 14;
  generation 4 batch count changes from 15 to 10. Amazon, Reddit, Etsy and other
  blocked platforms are absent; thegoodtrade.com and other eligible rows remain.
- Historical Amazon/Reddit/Apple release audit rows remain (13 rows).
- Provider usage ledger remains 273. All four historical profile-sync jobs remain
  waiting_provider with unchanged August 27 timestamps after restart.
- Provider availability remains enabled for manual testing. No paid discovery,
  AI enrichment, browser collection, or Gmail send was initiated by this repair.

This is local-runtime verification, not a new real-provider generation acceptance
run or a claim that every unknown website has been semantically qualified.

## Whole-Supply Filtering Follow-up

The generation finalizer now owns full-supply filtering, before ordering,
partitioning, effective counts, and order fingerprints. The persistence layer
still checks complete original lineage first. Calling the shared finalizer
directly cannot accidentally partition unfiltered candidates.

The 100-candidate regression excludes 20 unsuitable entries and produces exactly
the same batches and fingerprints as supplying only the 80 eligible entries.
The existing dynamic release-batch sizing policy is unchanged; release batches
and 25-row UI pages are different concepts.

The PostgreSQL historical-feed regression verifies 100 published entries with
20 excluded targets produce pages of 25, 25, 25, and 5, with totalCount=80,
no duplicate domains, and no excluded domains. Filtering happens before LIMIT
and cursor pagination, not after taking 25 rows.

Published history remains immutable and actor/batch entitlement remains intact.
Selecting a particular batch does not pull entries from another batch to fill
the page. Unpublished inventory is not automatically released, and insufficient
eligible inventory does not trigger paid discovery just to fill a page.

Follow-up verification: 30 focused tests passed, including generation service,
whole-supply filtering, canonical persistence, and feed PostgreSQL integration.
Core build and focused ESLint passed. Build:
`local-product-5a20388223df3ac50eaab0f1`.
