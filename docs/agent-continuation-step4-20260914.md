# Agent Backlinks Continuation - Step 4

## Boundary

- Root: `C:\Users\DELL\Documents\缝合\john3947-seo-main`
- Branch: `main`; baseline HEAD: `506d88fac0fa81503e54aebdfc4ac9e68974997b`.
- Snapshot: `.codex-checkpoints/agent-continuation-step4-20260914`.
- Provider ceiling: zero calls, zero actual emails, no grants created.
- Stop: recommendation-to-verified-draft continuation; no approval or send integration.
- No persistent migration, service restart, commit or push.

## Ownership

- Agent: `models.py`, `backlinks_read.py`, `backlinks_drafts.py`,
  `backlinks_pipeline.py`, `activities.py`, `workflows.py`, and new
  `backlinks_continuation*.py`.
- API: `agent_backlinks_consent.py`.
- Consent status: `backlinks_consent.py` and its existing test fixture, so an
  explicitly started run is not incorrectly reported as disabled.
- Core: `api/private-server.ts`, `runtime/local-product-ai-runtime.ts`,
  `runtime/production-runtime.ts`, new read-only automation budget route.
- New migration 0068, focused continuation/budget tests and this report.
- Other dirty files remain owned by preceding tasks.

## Acceptance

1. Explicit consent start queues an existing AgentWorkflow atomically.
2. Durable checkpoints progress through existing Core commands, with per-request
   consent and project checks, cumulative reservations and no send capability.
3. Pending work waits without model polling; uncertain writes stop without retry.
4. Synthetic and isolated database checks are reported separately from real
   providers, deployed migrations and user acceptance.

## Implemented

- Explicit `POST .../agent/automation/consents/{consent_id}/start` with strict
  `confirmed: true` and a `DraftRequest`. Creating consent alone does not start work.
- `GET .../agent/automation/consents/{consent_id}/execution` returns scoped progress,
  per-item results, reservations and the existing Agent run/conversation IDs.
- One run per consent; a replay returns that run and never resets its allowances.
  A changed request conflicts. Project locking prevents concurrent automation starts
  through different consents. A ready-project trigger is required.
- Existing `AgentWorkflowDispatch`, `AgentWorkflow` and Agent worker are reused.
  Fixed orchestration calls the existing pipeline adapters; no new model polling,
  provider implementation, worker or queue.
- Initial generation is started only if absent. Existing generation identity is
  pinned. Completion precedes initial publication and stable ascending pagination.
  This does not request later gated batches or replace failed generations.
- Released recommendations without an email are excluded. Core's existing opportunity
  readiness and confirmed-contact checks still decide eligibility. Existing drafts
  are never overwritten.
- Accepted draft jobs are polled with durable waits; each successful job then requires
  matching opportunity, text, contact snapshot, freshness and unapproved MODEL status.
- SQL checkpoints and a fenced lease preserve completed work. A committed write intent
  without a verified receipt pauses for review instead of issuing another write.
  Ordinary checkpointed waits resume; this is not automatic recovery of unknown writes.
- Every HTTP request rechecks consent, expiry, current project scope/status and run
  cancellation. Roles come from the authenticated start; no short-lived chat token is
  renewed. There is no persistent membership-revocation source in the current auth
  architecture, so this does not claim continuous live membership lookup.
- Cost admission uses Core's read-only configured reservation quote. Cumulative
  reservations are not settled provider bills and are not automatically refunded.
  Draft allowances count attempts, including skipped/existing drafts, conservatively.
  Unknown bounds stop admission. Existing Core execution-time budget gates remain.
  API and worker configuration consistency still needs deployment verification.

## Verification

- `TESTED`: 595 API/Agent tests passed, including 34 new continuation tests.
- `TESTED`: 26 Core tests passed, including 6 new budget-route tests, plus adjacent
  recommendation feed, user release, private server and AI runtime checks.
- `TESTED`: Core `tsc --noEmit`, focused Ruff checks and Git whitespace checks passed.
- `TESTED`: Alembic reports one head, `20260914_0068`.
- `TESTED`: Real PostgreSQL checks used only `seo_agent_v11_test`, unique temporary
  schemas and an outer rollback. Both migrations 0067/0068 were exercised there.
  No persistent schema or business rows were created.
- `TESTED`: API start/replay/conflict, job waits, multiple drafts, pagination,
  contact/freshness failures, lost receipts, cumulative limits, cancellation,
  expiry, project archival/scope changes, lease ownership and consent revocation.
- `TESTED`: Temporal control logic was mocked to check durable-wait calls and
  continue-as-new after 100 steps. A running Temporal worker was not exercised.
- `PRESERVED`: 51 unrelated dirty files have identical baseline SHA-256 hashes.
  No unexpected new/changed files; HEAD unchanged. Audit is in the checkpoint folder.
- `NOT RUN`: provider calls, actual ElephTV acceptance, browser UAT, migration of
  the running application database, service restart, deployment, commit or push.

## Remaining

1. User-visible authorization/start controls and progress presentation, including
   wiring the project-ready event to a separately authorized start.
2. Integrate the existing approval/send confirmation and paced send-intent workflow;
   this continuation has no approval or sending stage.
3. Apply the additive migration and verify the real worker after separate runtime
   authorization; accept the no-send flow first, then obtain explicit send permission.
