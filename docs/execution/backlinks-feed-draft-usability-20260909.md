# Feed and Draft Usability Verification

Date: 2026-09-09

## Scope

- Default recommendation order: public email first, then contact page, then no contact.
  The priority is applied in SQL before pagination and retained in keyset cursors.
- Contact outcome displays usable email or a clickable contact page; partial completion
  without an email now says no public email was found.
- Promotion pages are editable and persisted through the existing project authority
  API, with own-domain validation and optimistic version checks.
- Diagnose and repair the failed Aiper draft without sending email.
- No new discovery or paid traffic enrichment was requested by this verification.

## Live Evidence

- Original model run `3d5d9ef9-84e0-4990-b7a2-d8b1b4b237ec` failed.
  The provider rejected `gpt-5.4-mini` as unsupported by its account, despite listing
  it in `/models`. A tiny probe of the already-used `gpt-5.6-terra` succeeded.
- Runtime draft model changed to that supported model. The first full regeneration
  then hit the existing token guard. Compatible GPT-5 requests now default to low
  reasoning effort; token and absolute cost guards remain enabled.
- Successful model run `001e31fd-39b3-4b07-a84a-384449968bc4`:
  `SUCCEEDED`, input 1222 tokens, output 1411 tokens, zero schema repairs.
  The stored cost estimate is based on configured rates, not a verified provider invoice.
- Draft `2e0a3282-f92c-4353-ad20-cdc8e4ade06c` appeared in the real UI with saved
  subject/body and pending approval. No approval or send action was performed.
- Added `https://aiper.com/` alongside `https://aiper.com/us` through the actual
  editor. Both persisted after browser reload.
- Aiper feed retained 41 results after the promotion-page change. Email-bearing
  sites appeared first, including the older PoolMagazine item. Page two loaded.

## Traffic

The round-five backlink source responses provided rank and spam metrics, not organic
traffic. See `aiper-v2-competitor-discovery-20260909.md`. Missing traffic is not zero.
This task did not fabricate values or initiate a separate paid traffic lookup.

## Verification Boundary

Focused backend and frontend tests were executed. Core build succeeded and the local
API/worker run build `local-product-990e8e57c0d44796e08bb65d`.
Frontend full typecheck still reports the existing nullable latestGeneration fixture
contract mismatch in recommendation-feed-workspace.test.tsx. This is not a claim of
full repository CI, production deployment, or completed user acceptance.
