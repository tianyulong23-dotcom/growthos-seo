# Agent confirmed batch send - Step 6

## Boundary

- User authority: continue the next coding step, not permission to send.
- Root: `C:/Users/DELL/Documents/缝合/john3947-seo-main`.
- Branch main; HEAD `506d88fac0fa81503e54aebdfc4ac9e68974997b`.
- Snapshot: `.codex-checkpoints/agent-send-step6-20260914`, 74 dirty files.
- Owned existing files: Agent models, send adapter, activities, workflows;
  consent API routes; frontend automation API/panel, its status-label test,
  and mail tab integration.
- New files: batch service, additive migration 0069, batch UI, focused tests,
  and this report. Narrow Core addition: send-batch-preflight helper and route
  in send-intent.route.ts. Existing individual create/send commands, queues,
  provider adapters and recommendation logic are unchanged.
- Real provider calls, emails, grants, business jobs: zero.
- No persistent runtime migrations, service restart, commit or push.

## Contract

Only already-approved current drafts can enter a preview. A separate explicit
human confirmation binds the exact server-held preview, recipients, account,
versions and readiness snapshots. No automatic approval or future blanket
authorization. Draft consent alone is never send authority.

Reuse AgentWorkflow dispatch for bounded sequential submission and readback;
reuse Core send intents for pacing, retries, deduplication and reconciliation.
Uncertain submission stops without replacing its operation ID or auto-retrying.

Batch preflight plans successive QUOTA revisions (used + item index). It does
not reserve capacity; each existing Core create command still compares the
exact readiness snapshot. Concurrent quota changes fail closed.

## Verification

- IMPLEMENTED: explicit server-held manifest confirmation; scoped authority;
  durable sequential submission; status polling; revocation of future submits.
- TESTED: 177 API consent/send/continuation tests, using the dedicated
  seo_agent_v11_test database with isolated rollback-only schema; 145 adjacent
  Agent activities/tools/draft tests; 56 Core send tests; 18 frontend component
  tests; 12 adjacent mail/project/runtime source tests. Total: 408 passed.
- Core and frontend TypeScript checks passed. Scoped Core/frontend ESLint,
  new batch Python code and route/adapter Ruff checks passed.
- Broader activities/workflows Ruff reports 9 pre-existing findings, confirmed
  against the before snapshot with identical diagnostic codes. Left unchanged.
- OpenAPI baseline check passed (88 paths); git diff whitespace check passed.
- BROWSER_MOCK: existing Vite frontend at localhost:5173; desktop 1440x1000
  and mobile 390x844. Verified read-only mount, explicit preview/confirmation,
  exact manifest, READY then PROVIDER_ACCEPTED polling, and no panel overflow.
  Two intercepted mock POSTs; zero external requests. Screenshots and runner
  are under the Step 6 checkpoint directory.
- Ownership: only 9 of the 74 snapshotted dirty files changed this step, all
  listed above, plus the previously clean Core route. Other baseline hashes
  unchanged. HEAD and branch unchanged.

## Remaining Gates

- LOCAL_RUNTIME / REAL_PROVIDER / HUMAN_UAT: not established by mocks.
  Migration 0069 has not been applied to the business database and backend
  services have not been restarted. Do not use the UI to send until API, Core,
  worker and migration are deployed together and checked.
- Real Gmail sending, delivery, replies and pacing have NOT been accepted.
- Current batch is at most 20 approved current drafts and expires within five
  minutes (or earlier source authority/readiness expiry). Monitoring is bounded
  to 24 hours. Expired previews require fresh preview and human confirmation.
- Revocation stops future submissions, not Core intents already queued.
  Uncertain submission pauses for reconciliation; it is not automatically
  resubmitted under a new operation ID.
- This is human-confirmed batch sending, not automatic approval or blanket
  consent for future generated drafts. Project-creation automatic sending and
  live end-to-end acceptance remain separate gates.
