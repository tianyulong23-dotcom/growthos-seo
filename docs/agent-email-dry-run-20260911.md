# Agent Email Dry Run

Date: 2026-09-11.

## Scope And Ownership

- Authorized: first option, no real email; minimum preflight adapter and simulated lifecycle.
- Repository: john3947-seo-main, main, HEAD 506d88fac0fa81503e54aebdfc4ac9e68974997b.
- Preserve all pre-existing dirty files. Own only the new preflight adapter, its registry/activity/prompt/progress wiring, focused tests and this report.
- Provider ceiling: zero Gmail, AI and DataForSEO calls. No live business writes, database migrations, service restarts, commits or pushes.
- Use synthetic data and HTTP MockTransport. Existing human approval and confirmation are simulated test inputs, never model-created production authority.
- Checkpoints: inspect contracts; implement and test preflight; run synthetic generation/query/verification/preflight/send-result/tracking plus finite-list failure/recovery; report evidence.
- Stop: no live send tool, no new approval system, no batch tables/queues.

## Result

TESTED / PASS for the synthetic scope below, not live conversation or complete autonomous sending acceptance.

### Implemented

- Added `preflight_backlink_email`, a thin adapter to existing POST `drafts/{draftId}/send-preflight`.
- Reused ToolRegistry, operation hashing, signed project/organization/user delegation and existing write execution. No additional business service, batch table, queue or scheduler.
- Required explicit preflight intent; model arguments cannot contain human confirmation, delegation, organization overrides or an operation key.
- Read the saved draft before preflight. Reject mismatched approval/current version/contact, stale content or missing text. Core remains the final policy authority.
- Successful preflight reports `NOT_SENT`, not a submitted task. Human approval/confirmation stays on the existing draft page.
- Added activity dispatch/progress and prompt guidance.
- Activity-level testing reproduced loss of `deliveryState` during tool-result compaction. Preserved the bounded preflight evidence in the existing compactor; the activity replay test now passes.

### Synthetic Lifecycle

The test calls the production registry, adapters and signed gateway with HTTP MockTransport. Generation, approval, send states and replies are synthetic fixtures, not real provider output.

1. Submit a draft job and query its persisted acceptance.
2. Query a simulated SUCCEEDED job and inspect text, MODEL source, contact snapshot and freshness.
3. Reject preflight before approval, without making the preflight POST.
4. Simulate the existing page's human approval and run the production preflight adapter.
5. Inject a simulated page submission result and query READY, DISPATCHING, PROVIDER_ACCEPTED and DELIVERY_UNKNOWN.
6. Verify that unknown delivery is not represented as safe to resend, and provider acceptance is not proof of delivery/read.
7. Query an empty saved mailbox, then inject a matched reply and follow returned local message/thread IDs through the production detail tools.
8. Run three isolated preflight fixture items with one 503 failure; retry only the failed item. POST counts are 1, 2, 1.
9. Simulate a lost submission response by making its persisted intent available, then locate it by draft ID without a send POST.
10. Execute the real Agent activity using server-owned scope despite forged payload scope; replay its completed result without another HTTP call.

Steps 5 and 9 inject saved send evidence. They do not execute an Agent send adapter or prove autonomous recovery decisions. The finite-list loop is a test driver, not a newly deployed batch runner.

### Verification

```text
backend/api:
.\.venv\Scripts\python.exe -m pytest tests/test_agent_email_dry_run.py tests/test_agent_backlinks_read.py tests/test_agent_backlinks_drafts.py tests/test_agent_tools.py tests/test_agent_model_gateway.py tests/test_agent_activities.py -q --tb=short
429 passed in 20.67s

backend/core:
npx vitest run test/backlinks/api/send-intent-route.test.ts test/backlinks/api/reply-mail-route.test.ts test/unit/gmail-send-intent-command.test.ts test/unit/send-intent.query.test.ts
46 passed, 4 files
```

- New dry-run file: 33 cases, including lifecycle, unsafe parameters, explicit intent, stale approvals, permission/scope denial, upstream errors, corrupt success responses, partial preflight failure and activity replay.
- Existing Core tests separately exercise send commands/routes and confirmation contracts with test dependencies. They are not an integrated Agent-to-Core send submission run.
- `git diff --check` passed; only existing CRLF conversion warnings.
- A first fixture attempt blocked Windows asyncio's internal socket pair. Replaced that fixture guard with a block on the real HTTP transport; HTTP requests use MockTransport exclusively.
- No service started, no shared service restarted, no real project draft generated or edited.

### Changed Files This Turn

- `backend/api/app/modules/agent/backlinks_preflight.py`
- `backend/api/app/modules/agent/tools.py` (preflight wiring only)
- `backend/api/app/modules/agent/activities.py` (intent/delegation wiring only)
- `backend/api/app/modules/agent/progress.py` (preflight labels only)
- `backend/api/app/modules/agent/model_gateway.py` (preflight instructions and compaction only)
- `backend/api/tests/test_agent_email_dry_run.py`
- This report.

### Remaining Boundaries

- Real Provider calls and provider cost: zero.
- No real-model conversation, live draft generation, live preflight, Gmail send/sync, deployment or human UAT in this run.
- No user-confirmation bridge or send submission tool was opened to the model. Sending still uses the existing page, and the Agent can query its saved results.
- A fully conversational batch send flow still needs trusted confirmation handoff, the send adapter and subsequent integrated tests. Do not report this synthetic result as completion of that capability.
- No commit/push; pre-existing dirty changes preserved.
