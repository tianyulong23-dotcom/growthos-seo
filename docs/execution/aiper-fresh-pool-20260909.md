# Aiper fresh recommendation pool

- Task: AIPER-FRESH-POOL-20260909; current user instruction.
- Baseline: main, 7df8d48d088328bd79fb0a1afef364b17cc8b6af.
- Existing dirty work is preserved. Ownership: shared outreach target policy,
  focused exclusion regressions, this report, and Aiper product operations.
- Scope: exclude giant official/platform domains without new generic admission
  gates; retire Aiper's visible old pool through supported product operations
  while retaining audit and downstream facts; generate one new Aiper pool.
- Providers: one Aiper generation under existing configured budget/call limits.
  No budget increase, Gmail send, historical sync resume, or repeated generation
  to force acceptance. Stop if budget/readiness is blocked.
- Verification: domain policy, V2 admission, finalization, historical feed and
  opportunity exclusion tests; current runtime and original Aiper UI/DB evidence.
- No commit, push, direct live SQL mutation, or deletion of audit records.

## Progress

## Implementation and tests

- Shared outreach target policy upgraded to v2 with additional giant official
  domains, including Android and related official domains. Exact domain and
  subdomain matching also handles case and trailing dots; independent editorial
  sites such as androidauthority.com and macrumors.com remain eligible.
- Existing policy wiring covers V2 admission, pre-batch finalization, historical
  feed/export before pagination, and Opportunity eligibility. No new generic
  rank threshold, AI screening, or V2 relevance gate was added.
- Five focused test files: 153 tests passed. Coverage includes null metrics,
  domain variants, independent sites, full-supply filtering, historical feed,
  export, stale Opportunity actions, and canonical batch behavior.
- Core build passed: local-product-0a23e61055a8c2e30328f01d.
- Core API, worker, and platform API restarted using existing runtime helpers.
  Runtime status reported current matching builds and running business consumers.
- Targeted git diff --check passed.

## Aiper live acceptance

- Project: b35ab775-fabd-44a9-a7c7-82406242893d, aiper.com.
- Archived all six previously visible recommendations through the normal UI.
  Immutable history and downstream facts were retained, not physically deleted.
  V2 already-released deduplication still applies to archived recommendations.
- Started exactly one new generation through prepare/confirm/generate UI actions.
- Generation: 5dd92c24-1130-4778-a095-9901888f34d9 (visible generation 4).
- Job: 5d9f2493-e874-4c3a-8fff-fc6968f4b7c5.
- Durable terminal result: success / published / 100%, no job error.
- 22 candidate domains: 3 admitted, 19 excluded.
- Four permanently excluded domains: amazon.com, reddit.com, yahoo.com,
  youtube.com. Another 15 were already released to this project.
- Published and verified in the original browser UI: bhg.com,
  poolmagazine.com, intheswim.com. Exactly one visible batch with three items.
- Four DataForSEO requests succeeded and settled. Actual ledger cost:
  2,400 USD micros ($0.0024); estimated reservation total was $0.1104.
  This is the observed DataForSEO ledger charge, not a total-service cost claim.
- All four protected historical profile-sync jobs remain waiting_provider with
  unchanged August 27 timestamps. No Gmail send or budget increase was performed.
- Frontend: http://localhost:5173/projects/b35ab775-fabd-44a9-a7c7-82406242893d/backlinks/recommendations

## Remaining limitations

- Contact preparation terminated partially completed: one ACCESS_DENIED and
  two CAPTCHA_OR_BOT_CHALLENGE results. Publication does not mean usable contacts.
- All three visible items still show unknown traffic, DataForSEO Rank and Spam.
  This run does not establish metric completeness or full outreach readiness.
- Exclusion is a maintained domain policy, not universal recognition of every
  giant company. Newly encountered official domains may require policy updates.
- LOCAL_RUNTIME / REAL_PROVIDER / SAMPLE_ACCEPTANCE: exclusion and fresh
  publication verified. No deployment or human UAT claim.
