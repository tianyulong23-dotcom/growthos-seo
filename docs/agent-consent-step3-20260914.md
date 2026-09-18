# Agent automation consent: step 3

## Start Card

- Authority: current conversation, next coding step after step 2.
- Repository: john3947-seo-main; main; 506d88fac0fa81503e54aebdfc4ac9e68974997b.
- Scope: durable project/user consent storage and authenticated API only.
- Ownership: Agent models, Agent router inclusion, new consent service/routes,
  additive migration, focused tests, this report.
- Snapshot: .codex-checkpoints/agent-consent-step3-20260914; 53 existing dirty
  files; before-images of the two owned existing files.
- Provider calls and cost: zero. No sends, business jobs, runtime restart,
  applied migration, consent activation, commit or push.
- Checkpoints: implement storage/API; test scope, replay and revocation;
  run adjacent regressions and ownership audit.
- Stop: no dispatcher activation or short-lived delegation renewal. Completion
  continuation, authorization UI and real acceptance remain subsequent work.

## IMPLEMENTED

- Authenticated project-scoped POST `/agent/automation/consents`, GET
  `/agent/automation/consents/{id}`, and POST
  `/agent/automation/consents/{id}/revoke`, under the existing project API prefix.
- Identity comes from the current platform resolver, not request body or model.
  Records bind organization, workspace, project and consenting user. Only that
  user with current project permissions can inspect or revoke the record.
- Explicit boolean confirmation, fixed drafts-only policy version, expiry no more
  than seven days, bounded opportunity/draft counts and model/paid-tool budgets.
  These are persisted policy limits, NOT yet execution budget accounting.
- Unique request identity and PostgreSQL conflict handling preserve the original
  receipt. Changed payload conflicts; retries cannot extend expiry or reactivate
  revoked consent. Revocation is idempotent and retains its original timestamp.
- No send/approval permission, environment switch, model tool for issuing consent,
  session credential or delegation renewal. Every response explicitly reports
  `automation_enabled=false` and `sending_allowed=false`.
- Additive migration `20260914_0067` follows the existing single Alembic head.
  No existing migration was changed.

## TESTED

- Final focused regression: **255 passed**, comprising **46 new consent tests**
  plus 209 existing Agent API, tools, pipeline and send-adapter tests.
- Eight consent persistence cases used only the existing `seo_agent_v11_test`
  database. Each created a random isolated schema, exercised the actual migration
  upgrade and store, then rolled back the outer transaction including all DDL.
  No persistent schema migration or business data changes were performed.
- Covered authorization input injection, time/count/budget bounds, permission
  failures, server-derived scope, expiry, replay, conflicting requests,
  revocation and cross-organization/workspace/project/user isolation.
- New files pass Ruff; owned tracked changes pass CRLF-aware whitespace checks.
  `alembic heads` reports the single head `20260914_0067`.
- All **52 unrelated pre-existing dirty files** match baseline hashes. No
  unexpected dirty files outside the seven owned paths.

## Stop and Next Work

This completes the durable consent BACKEND substep, not full step-3 unattended
automation. No user consent was granted, no deferred trigger was released, and no
real model/provider/mail calls, restart, commit or push occurred.

The running product will need the normal reviewed migration/deployment procedure
before these new endpoints can use the table. That procedure was not performed.
The authorization UI is not implemented in this substep.

Next: connect explicit consent to bounded durable continuation using existing
workflows. Re-check current authority and persisted consent before each admitted
action; account for cumulative usage atomically, not once per model invocation;
wait for authoritative recommendation publication and draft completion; preserve
uncertain-result readback and cancellation. A consent record alone must not
be treated as a renewable platform session or an outreach send confirmation.

Then expose the authorization UI and perform the deferred real-Agent acceptance.
Actual sending remains a separate, explicitly confirmed stage.
