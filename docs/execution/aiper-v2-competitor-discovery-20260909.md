# V2 competitor backlink discovery

- Task: AIPER-V2-COMPETITOR-DISCOVERY-20260909, current user request.
- Repository: john3947-seo-main, main, baseline HEAD
  7df8d48d088328bd79fb0a1afef364b17cc8b6af.
- Preserve the existing dirty worktree. Owned areas: V2 request selection,
  competitor seed validation and request lineage, focused tests, this report.
- Implement competitor backlink discovery alongside search, using confirmed
  project competitors and source-page evidence. Keep existing admission rules.
- Live boundary: one new Aiper generation using normal product commands and
  existing provider limits; no ceiling increase. Maximum generation budget is
  the existing $2 policy, subject to any lower runtime authorization, with the
  existing 25-paid-request cap. No repeated generations to force success.
- Do not delete history, resume protected sync jobs, send Gmail, commit or push.
- Verify focused planning, runtime, admission and persistence regressions,
  then local build/runtime and Aiper request ledger, published results and UI.
- Stop after reporting the real result and cost, including missing evidence.

## Investigation

- Current native V2 filters planned calls to search only.
- Competitor backlink request construction already uses live backlinks,
  one referring domain per row, no internal or indirect links, and 100 rows.
- Aiper's last generation has four confirmed keyword seeds and no competitor
  seed. Competitor evidence must be established before its live run.
- No new provider requests have been issued during initial inspection.

## Implementation and local verification

- V2 consumes only VERIFIED SEO_COMPETITOR seeds bound to its immutable
  generation blueprint. Historical AI blueprint domains cannot authorize calls.
- Competitor requests alternate with SERP requests within existing request and
  monetary limits; own referring domains remain outside this native path.
- Request intent seed IDs and fingerprints match the exact competitor target;
  page type is backlinks, not organic. Missing/unverified lineage fails before
  provider execution.
- Live competitor results require observed source and target URLs, the requested
  competitor as target, and an active link. Existing admission/exclusion,
  deduplication, metric persistence and publication rules remain in effect.
- Focused regression: 5 test files, 91 tests passed. Owned-file ESLint and
  git diff --check passed. Core build passed.
- Competitor seed matching uses the same registrable-domain normalization as
  the planner, including confirmed competitor subdomains.
- Local API and worker both report local-product-7e3c8dd3454381cf2fb251d6;
  normal worker mode, business consumers running.

## Authorized Aiper generation

- Normal UI: prepare seeds, confirm snapshot, generate once.
- Competitors: maytronics.com and beatbot.com. Public official homepage titles
  and descriptions verified robotic/cordless pool cleaner product overlap.
- Generation: ba2089bf-0c1d-4717-9a53-e7d9c8758201, visible round 5.
- Existing historical results and PoolMagazine opportunity preserved.
- Four successful provider requests: two backlinks/live and two SERP task_post.
  Each backlinks request cost 27,600 micros; each SERP cost 600 micros.
  Total settled DataForSEO discovery cost: 56,400 micros ($0.0564).
- 217 observations, 207 unique domains; 190 admitted, 12 already released,
  5 permanently excluded. Stop reason SAFE_SUPPLY_REACHED; no further discovery.
- Excluded: amazon.com, reddit.com, youtube.com, pinterest.com, and
  ec2-52-36-128-238.us-west-2.compute.amazonaws.com.
- All 190 admitted domains have persisted AVAILABLE AUTHORITY_RANK and
  SPAM_SCORE snapshots. Organic traffic absent in these responses;
  no extra metric enrichment requests were issued.
- Five release batches of 38 were created using the existing publication policy.
- At 2026-09-09 16:22:38 Asia/Shanghai, batch 1 reached AVAILABLE (38/38
  contact-terminal); batch 2 was already AVAILABLE. Batches 3-5 remain PREPARING.
  AVAILABLE is preparation state, not proof that a batch is unlocked/published.
- After deployment and normal UI refresh, round 5 shows completed, admitted
  190, published 38. The combined historical feed shows 41 results (38 new +
  3 preserved historical), with 25 displayed on the first page.
- UI metric examples: browningpools.com rank 33 / spam 0;
  activite-piscine.com rank 36 / spam 30; bookoccino.com rank 11 / spam 10.
  Traffic correctly remains unavailable. No extra metric requests.
- Contact jobs for the first two prepared batches: 12 completed, 16
  no_contact_found, 48 partially_completed. This is not a claim of 76 emails.
- Screenshot evidence:
  output/playwright/aiper-v2-competitor-round5-20260909.png and
  output/playwright/aiper-v2-competitor-round5-metrics-20260909.png.
- Final request ledger recheck: the same four succeeded requests and $0.0564
  settled DataForSEO discovery cost. This figure excludes AI/browser services.
- Protected historical sync jobs remain waiting_provider (4).

## Outcome

- IMPLEMENTED, focused TESTED, LOCAL_RUNTIME and real Aiper discovery/feed
  acceptance verified. No production deployment or human UAT is claimed.
- Competitor backlink evidence proves a source links to a confirmed competitor;
  it does not prove every admitted domain is a willing outreach partner.
- Existing UI still renders some competitor reason codes as repeated generic
  reasons and the supply-stop detail as status pending. Those presentation
  limitations were observed but are outside this discovery-source change.
