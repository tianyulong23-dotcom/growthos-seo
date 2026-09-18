# Agent Backlinks Execution Preflight

## Start Card

- Task: AGENT-BACKLINKS-EXEC-PREFLIGHT-001, user-authorized next stage after
  successful GPT-5.5 read acceptance.
- Source: main at 506d88fac0fa81503e54aebdfc4ac9e68974997b,
  origin https://github.com/john3947/seo.git.
- Ownership: opportunity summary display, focused regression tests, this report.
  Preserve all existing Agent changes and untracked checkpoint/evidence files.
- Provider ceiling: zero AI, Gmail, DataForSEO calls; local GET/UI only.
- Checkpoints: reproduce incorrect contact summary; fix using authoritative
  path state and truthful list scope; test and compare the real ElephTV page;
  inspect the first draft command's execution prerequisites.
- Stop: no new write tools, business mutations, OAuth changes, shared service
  restarts, commit or push. This preflight does not authorize email sending.

## Draft Command Inspection

- Reuse the existing POST opportunities/{id}/draft-jobs, not a new draft engine.
  Its strict request requires contactId/contactVersion, logicalDraftKey,
  structured draft request and idempotency-key.
- The Core command checks actor role, snapshots project/opportunity/contact
  evidence, persists the job and schedules its workflow. Job status and draft
  read endpoints already exist; job acceptance is not draft completion.
- Promotion URL, language and cooperation intent must be grounded in project
  data or explicit user input. Existing drafts must not be overwritten.
- Agent BacklinksReader currently has only local-development read authority;
  it deliberately fails closed outside that mode. The general Agent write
  registry does not delegate authenticated Backlinks write permissions.
- Therefore the first execution integration must bind the real initiating
  user's project/tenant permissions to the durable run, revalidate authorization,
  preserve contact-version conflict handling and stable retry idempotency.
  Do not grant write authority merely by modifying the read adapter's scope.
- Draft creation, draft approval and email sending are separate commands.
  Gmail refresh failure blocks send/sync readiness, not reading saved data.
- The saved gpt-5.5 override belongs to Agent. Core draft generation has its own
  generationMode/provider/budget dependencies and needs separate verification.
  A successful Agent call does not prove the draft provider is available.

## Verification

- IMPLEMENTED: contact summary now uses engagementPathState rather than business
  stage. "Email contacts ready" does not claim Gmail send readiness. Counters
  explicitly cover the current list, not an unqueried project-wide total.
- Reproduction: original EMAIL_READY/JOINED browser test failed with pending
  expected 0, actual 1. Real ElephTV page showed pending 3 / contactable 0.
  Preimage and failure screenshot retained in ignored
  `.runtime/agent-preflight-20260911/`.
- TESTED: 10 desktop/mobile Playwright tests passed (15.9s), including path/stage
  disagreement, manual path, missing path, partial-list scope and existing
  archive/restore behavior. No mutation was requested by the new read-only tests.
- Adjacent source checks: 18/19 passed across opportunities, drafts, mail and
  project authority. Existing mail-center-source.test.mjs:141 fails because its
  ordering assertion searches for a single-line SendIntentQueue JSX signature.
  Both mail source and its test are unchanged from HEAD; do not claim this
  adjacent suite fully green. No unrelated mail edit made.
- TypeScript project build, new test formatting and scoped diff check passed.
- LOCAL_RUNTIME: existing 5173 UI / 7200 API, real ElephTV page now shows active 3,
  pending contacts 0, email contacts ready 3, negotiating 0. Browser screenshot
  confirms labels fit. Shared services were not restarted.
- Shared Agent sidebar still displays an earlier failed task. This frontend
  verification does not reload Agent workers or supersede the isolated GPT-5.5
  acceptance; do not represent the shared chat as runtime-verified here.
- First proposed draft sample: barnardmedia.co.za, opportunity
  ebe03fcf-1aad-43a5-bc13-20279636a23c, version 1, no draft, EMAIL_READY,
  CREATE_EMAIL_DRAFT enabled. Contacts GET returned one active, non-guessed,
  confirmed contact at version 1 with AUTO_SELECTED state. No address copied here.
- REAL_PROVIDER: no calls performed; Gmail recovery and draft-provider validation
  remain separate. No draft, approval, send intent or other business write made.
- Next stage: authenticated Agent write delegation and bounded create-draft job
  adapter, with explicit intent, contact/version checks, idempotent retries and
  job/draft readback. Stop before approve/send. The inspected existing command
  must remain the business authority; do not reuse read-only local authority.
- Git publication: none. Existing dirty Agent/checkpoint work preserved.
  Playwright used a new port (4197) because 4188 was already occupied; the test
  server exited. Existing 4188, 5173 and 7200 listeners were left untouched.
