# Agent pipeline: step 2

## Boundary and ownership

- Authority: current conversation, step 2; repository `john3947-seo-main`, branch
  `main`, HEAD `506d88fac0fa81503e54aebdfc4ac9e68974997b`.
- Checkpoint: `.codex-checkpoints/agent-pipeline-step2-20260914/`, 47 pre-existing
  dirty files, eight owned before-images.
- Owned: Agent pipeline/automation adapters, draft HTTP schema parameter,
  tool registry, activity dispatch, model prompt, progress labels, trigger
  repository filter, project projection success hook; focused tests and this report.
- Do not change Core, frontend, database schema, provider configuration, or
  existing sender/worker/queue implementations.
- Real provider calls/cost: zero. No real jobs, mail, migration, restart, commit or push.

## Checkpoints

1. Verify existing V2 generation, feed, opportunity and draft contracts.
2. Register bounded Agent write adapters and a deferred project-ready trigger.
3. Test synthetic call paths, authorization boundaries and adjacent behavior.

## Stop point

Automatic execution stays disabled pending the next durable authorization stage.
The ready trigger is pending and excluded at query time from the Agent dispatcher,
so it neither starts paid work nor blocks unrelated onboarding triggers.
No short-lived chat delegation is renewed or turned into durable authorization.
This stage does not yet provide unattended end-to-end orchestration: durable
authorization, continuation across long-running jobs and actual runtime acceptance
remain required. Existing authenticated chats may explicitly invoke the tools.

## IMPLEMENTED

- `start_backlink_recommendations`: scoped V2 feed read, then the existing
  seed-generate/launch commands using Core-returned immutable pins and stable
  child idempotency keys. Existing generations are not automatically replaced;
  incomplete inputs stop before launch.
- `join_backlink_recommendations`: up to ten released V2 feed IDs, existing
  opportunity-create command and persisted opportunity readback. Core still
  owns visibility, membership and domain deduplication.
- `create_backlink_drafts`: up to ten opportunities, sequentially, reusing
  existing draft jobs. Requires ACTIVE management and the enabled draft action;
  selects only the existing authoritative AUTO_SELECTED confirmed active contact.
  Missing/ambiguous contacts and existing drafts are skipped, never guessed,
  confirmed or overwritten by this tool.
- Per-item results distinguish accepted jobs, existing records, skips and
  uncertain responses. An uncertain item stops the batch with remaining IDs;
  prior receipts survive. Activity replay returns saved results, not new writes.
  QUEUED is not a finished AI draft. Existing job/draft read tools provide verification.
- Successful ready project projections register one pending initial trigger
  per organization/project using the existing unique constraint and transaction.
  Incomplete, inactive and failed projections do not register it.
- The dispatcher excludes deferred Backlinks triggers BEFORE LIMIT. They carry
  no trusted write tools and cannot starve unrelated onboarding tasks.
- All writes retain current server-held organization/project delegation,
  execution-time checks and prepared argument hashes. No authorization creation,
  self-renewal, draft approval, real send or Gmail repair was introduced.

## TESTED

- New pipeline tests: **79 passed**, including actual Agent activity dispatch
  against a synthetic HTTP Core, replay, partial/uncertain outcomes, scope/hash
  rejection, strict V2 schema, selected-contact rules, input limits, project-ready
  insertion and dispatcher exclusion.
- Existing adjacent Agent tests: **529 passed**. The final combined Agent run
  passed 605 tests before three additional activity outcome cases were added;
  the entire new test file was then rerun successfully with 79 tests.
- Project projection: **10 passed** using the already-existing
  `seo_agent_v11_test` database. Only this test process received its connection
  setting. No database creation/migration or business database write occurred.
  The earlier two environment-related skips were resolved by selecting this
  dedicated database. Publisher responses in these tests remain synthetic.
- Total distinct covered tests: **618** (529 existing + 79 new + 10 projection).
- New Python files pass Ruff. Owned tracked diffs pass `git diff --check`
  with the repository's CRLF whitespace setting.
- Hash audit: all **41 unrelated pre-existing dirty files unchanged**;
  no unexpected newly dirty files outside the ownership list.

## Remaining Evidence

This is IMPLEMENTED/TESTED at the call-adapter and deferred-trigger layer, not
REAL_PROVIDER_VERIFIED or unattended product acceptance. Service restart,
browser acceptance, real provider jobs and sends were not performed.

The next stage must add project-scoped durable automation consent and the
completion-driven continuation through recommendation publication and draft
verification. Only after this code is complete should the user enable consent
and authorize a bounded real run. Approval/send consent remains a separate boundary.
No unrequested commit or push occurred.
