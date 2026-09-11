# Pool contact propagation verification

Date: 2026-09-09

## Scope

Repair discovered-email propagation from the V2 recommendation pool into
Opportunity and the email draft contact picker. No Gmail sends, new paid
discovery, or historical synchronization resumes were performed.

## Findings and implementation

- The feed could overlay a later discovered email, while Opportunity creation
  still relied on the immutable release contact snapshot. Both now share the
  same scoped, evidence-backed public-contact query when that snapshot has no
  email. Original release facts remain unchanged.
- Existing opportunities without a confirmed contact now expose stored public
  email candidates and their evidence in the draft screen. Selection uses the
  existing candidate-confirmation command; it does not invent a manual contact.
  Confirmation remains a user action.
- The candidate API response schema omitted the business, marketing, and
  site_owner purposes, causing a real PoolMagazine response to fail validation.
  The schema, application type, OpenAPI contract, and generated client agree now.
- Candidate display is project, prospect, and context scoped. Guessed or expired
  evidence is excluded. Stale responses are discarded after scope changes.

## Evidence

- Backend focused API, feed, Opportunity integration, and repository tests:
  13 passed.
- Frontend contact-picker and draft-refresh tests: 6 passed.
- New component and test ESLint: passed.
- Generated Backlinks client check: passed, 89 operations.
- git diff --check: passed; existing Windows line-ending warnings remain.
- Core build and local runtime restart completed with build identifier
  local-product-58ebf34bcb081558fe98c2cb.
- The real Aiper / PoolMagazine candidate endpoint returned HTTP 200 and eight
  candidates. The real draft page displayed those candidates and source links.
  editor@poolmagazine.com was selected for visual verification, not confirmed
  or sent.
- Screenshot: storage/runtime/poolmagazine-mail-contact-20260909.png.

## Remaining boundary

Full frontend TypeScript checking still reports an unrelated existing null
assignment for latestGeneration in recommendation-feed-workspace.test.tsx:312.
No full frontend build pass or production deployment is claimed.
Actual candidate confirmation is covered by tests; human confirmation and mail
sending were not exercised against the real PoolMagazine opportunity.
