# Backlinks full-chain verification - 2026-09-08

## Start card

- Task: BACKLINKS-FULL-CHAIN-VERIFY-20260908.
- Authority: current user request to verify the full backlinks chain.
- Repository: john3947-seo-main; origin https://github.com/john3947/seo.git;
  branch main; HEAD 7df8d48d088328bd79fb0a1afef364b17cc8b6af.
- Ownership: existing dirty work is preserved. This task owns this report and
  verification artifacts, not unrelated implementation or migrations.
- Sample: existing ElephTV project 7e1c7515-b9b3-4247-80ed-12b3eecee3a2,
  first generation 7383be94-160c-45c9-ac62-7195181ded23.
- Reuse existing discovery/contact evidence. No new DataForSEO discovery calls
  or budget increases. At most one real AI draft request through the product
  UI, subject to existing configured budget controls.
- No real Gmail send without recipient/content confirmation. No fabricated
  live reply, placement, or monitoring success. Four historical sync tasks
  remain manual-only. No live SQL mutation, commit, or push.
- Checkpoints: current runtime and published pool; opportunity/contact/draft
  UI path; send/reply/placement/monitoring/effects regression and runtime reads;
  final evidence classification and external inputs still required.
- Stop: report verified passes and observed blockers; do not label mocked
  provider tests or historical evidence as current real-provider acceptance.

## Results

Overall: BLOCKED for current real end-to-end acceptance. Verification completed,
but passing automated tests does not constitute a successful live value chain.

### Live product path

1. Reused the existing first generation (38 candidates, 8 released). No new
   discovery was requested.
2. Added the published 365digital.africa recommendation through the UI.
   Opportunity a4a1138c-2ecf-44b5-b7a9-c5f625b26abd was persisted with the
   recommendation/context handoff and a formal contact.
3. Opened the opportunity draft action. Contact and target were populated.
   One real AI call produced draft 4cd37c6d-94c5-4b09-9df2-48796a5a4f5d.
   Refresh preserved the saved draft, current version, and pending approval.
   The AI usage ledger settled one AI_OUTREACH_DRAFT call at USD 0.000360.
   No approval or send was performed; this project's send intent count is zero.
4. Mail Center opens with a connected project mailbox and empty send/message
   lists. Sync is disabled. Its project sync state is
   WAITING_FOR_ACCEPTED_SEND, which is expected without a first accepted send.
   Separately, runtime maintenance is a real operational blocker (below).
5. Performance/backlinks opens with zero placements and no confirmed outcomes.
   It also shows an existing first backlink snapshot as pending; completion was
   not demonstrated and no refresh/discovery action was clicked.
6. Performance/reports opens with no published snapshot in the selected window.
   This is an empty-state read pass, not evidence of successful placement KPI.
7. Performance/overview fails with project_not_found, HTTP 404, for this same
   website project. The accompanying performance/articles request also returns
   404. This is not an acceptable empty state.

### Observed issues

- Runtime at approximately 19:37 CST reports status=maintenance and
  business_consumers_running=false. Core and Worker processes share running
  build local-product-ef0a6a63024b6c4e8597ad54, but expected build is
  local-product-78734c6a7b011b3ea563e7dc. reason_code=runtime_build_stale;
  recovery_action=restart_product_runtime. Postgres and Temporal are ready.
  No restart was performed during verification: preserve the user's historical
  manual-resume boundary and the concurrent dirty worktree.
- Mail diagnostics misleadingly says the Worker is not running although the
  runtime reports process_running=true. It derives the label from business
  consumer readiness, not process liveness.
- Opportunity summary shows one contact-pending and zero contactable items,
  while the created opportunity detail says the email path is ready and its
  draft has a selectable formal contact. The summary classifies JOINED and
  CONTACT_PREPARING as contact-pending in opportunities-workspace.tsx.
- The new project's performance overview 404 requires separate project
  resolution/runtime diagnosis; root cause is not established by this audit.
- Earlier recommendation quality gaps (android.com admission and unknown SEO
  metrics) are not resolved or certified by downstream draft success.

### Automated verification

- Core selected downstream suite: 100 files, 610 tests. Initial run passed
  609 and failed one 100-concurrent-allocation test because the shared
  PostgreSQL instance exhausted its connection limit.
- Reran opportunity-sequence-concurrency.test.ts against a disposable,
  isolated PostgreSQL instance with max_connections=220: both tests passed.
  Therefore all 610 unique selected tests have passing evidence, with the
  environment-specific initial failure explicitly retained.
- Frontend selected draft/Gmail/mail/performance/project-query Vitest suites:
  9 files, 38 tests passed.
- Outreach source checks: 42 passed, 1 failed. The failed literal layout
  assertion expects "<SendIntentQueue websiteProjectKey={websiteProjectKey}".
  The current JSX is multiline and includes a key prop. Actual UI order
  remains mail correspondence before send records. This brittle source
  assertion is still failing; it was not silently weakened or counted passed.
- Desktop Chromium fixture E2E: 6 tests passed, covering opportunity lifecycle,
  send status/reconciliation, reply/negotiation/placement lineage, and reports.
- The same selected mobile Chromium run completed with last-run status=passed
  at 19:34:54 CST; no Playwright test process remained at verification.
- Browser E2E uses API fixtures, not real Gmail recipients, replies, or live
  publisher pages. These passes cannot certify real provider outcomes.
- Disposable test container growthos-chain-verify-20260908 was stopped and
  automatically removed. Existing application services were left running.

### Evidence pointers

All snapshot paths are relative to the repository root. Raw browser artifacts
may contain mailbox details; do not distribute them as public reports.

- .playwright-cli/page-2026-09-08T11-28-45-089Z.yml: opportunity list.
- .playwright-cli/page-2026-09-08T11-29-21-666Z.yml: opportunity handoff/contact.
- .playwright-cli/page-2026-09-08T11-32-43-887Z.yml: persisted AI draft.
- .playwright-cli/page-2026-09-08T11-34-05-464Z.yml: paused mail diagnostics.
- .playwright-cli/page-2026-09-08T11-38-10-170Z.yml: overview 404.
- .playwright-cli/page-2026-09-08T11-38-33-284Z.yml: monitoring empty state.
- .playwright-cli/page-2026-09-08T11-38-58-777Z.yml: reports empty state.
- frontend/output/playwright/results/.last-run.json: mobile run completion.

### Remaining acceptance

Restore a current runtime without resuming the four historical manual-only
tasks, repair the project overview read failure and misleading status labels,
then verify a user-confirmed test recipient/content through approval, provider
acceptance, reply matching, negotiation facts, a controlled real source page,
placement validation, monitoring changes, and an immutable report snapshot.
Do not fabricate replies or insert placements directly into the live database.
CP11-CP14 in the core value-chain implementation plan require real lineage and
evidence. Current classification: live recommendation-to-draft PASS; automated
downstream coverage PASS with the source-test exception; operational readiness
BLOCKED; real send-to-monitoring acceptance INPUT_REQUIRED.
