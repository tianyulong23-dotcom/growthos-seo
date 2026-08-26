# BACKLINKS-CORE-REMEDIATION-PHASE-7 Result

## Start Card

- Task ID: `BACKLINKS-CORE-REMEDIATION-PHASE-7`
- Title: `AI Draft State Machine`
- Status: `COMPLETE`
- Started: `2026-08-17`
- Completed: `2026-08-17`
- Authority:
  - `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`
  - `docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`,
    Phase 7.
- Result artifact:
  `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-7-result.md`.
- Stop point: record the Phase 7 result and stop before Phase 8.
- Scope:
  - expose exact draft readiness and failure states;
  - retry malformed model output from the saved immutable request snapshot;
  - create an editable non-AI basic draft after non-policy model failures;
  - preserve refusal and policy failures without silent fallback;
  - create a labeled editable basic draft when the AI budget is exhausted;
  - preserve independent user edits when a later generation attempt completes;
  - update the API, generated client, frontend projection, and focused tests.
- Explicitly excluded:
  - Phase 8 Gmail connection and readiness work;
  - any DataForSEO, Browser/SafeFetch, paid AI, Gmail, or other Provider call;
  - deployment or mutation of the authoritative local database;
  - commit, push, pull, merge, rebase, checkout, clean, or unrelated cleanup.

## External Action Ceiling

- DataForSEO calls: `0`.
- Browser/SafeFetch calls: `0`.
- Paid AI calls: `0`.
- Gmail calls: `0`.
- Provider cost ceiling: `$0`.

## Verification Contract

- Cover every documented AI draft failure code.
- Prove malformed-output retry reuses the immutable request snapshot.
- Prove non-policy failures create and persist an editable non-AI basic draft.
- Prove refusal and policy failures do not create a fallback draft.
- Prove `BUDGET_EXCEEDED` creates a labeled fallback without retrying or
  reaching the Provider call.
- Prove concurrent user edits are not replaced by a later model completion.
- Prove discovery usage cannot change draft-generation readiness.
- Run focused backend/frontend tests, typechecks, OpenAPI/generated-client
  checks, and production builds.

## Result

### Implemented

- Added explicit Job readiness states:
  `QUEUED`, `GENERATING`, `RETRYING`, `AI_DRAFT_READY`,
  `BASIC_DRAFT_READY`, `POLICY_BLOCKED`, `BUDGET_BLOCKED`, and `FAILED`.
- Retried recoverable and malformed model output once against the exact saved
  immutable prompt snapshot.
- Persisted an editable `TEMPLATE_FALLBACK` basic draft for timeout, rate
  limiting, unavailability, misconfiguration, malformed output, and
  unclassified Provider failures.
- Kept `REFUSED` and `POLICY_VIOLATION` fail-closed without a fallback draft.
- Persisted a labeled editable basic draft for `BUDGET_EXCEEDED`.
- Preserved a concurrently saved manual version as current when a later
  generation attempt completed; the recovered basic draft remained in version
  history without replacing the user's edit.
- Released the `AI_OUTREACH_DRAFT` reservation when recovery produced a
  non-AI basic draft; only a real model result is settled as paid usage.
- Exposed `readiness` and `fallbackReason` through Backlinks OpenAPI, the
  aggregate platform contract, the generated frontend client, and the Draft UI.
- Kept raw basic drafts unapprovable until the user edits and saves an
  independent `MANUAL` version.

### Verification

- Backend workflow and API: `11/11` tests passed.
- Draft persistence and concurrent-edit integration: `9/9` tests passed using
  disposable local PostgreSQL.
- Independent AI capability budgets: `5/5` tests passed.
- Production runtime unit file, including reservation release: `10/10` tests
  passed.
- Backend TypeScript typecheck: passed.
- Backend production build: passed.
- Backlinks OpenAPI: valid, `76` paths.
- Aggregate platform contract: valid, `235` public paths and `265` operations.
- Generated Backlinks client: valid, `77` operations.
- Frontend Draft source contracts and polling: `10/10` tests passed.
- Frontend TypeScript typecheck: passed.
- Frontend production build: passed. Vite reported only existing chunk-size and
  ineffective-dynamic-import warnings.
- Scoped `git diff --check`: no whitespace errors; Git reported only the
  repository's existing LF-to-CRLF conversion warnings.

### Evidence Classification

- Code and contract evidence: `PASS`.
- Local disposable-database integration evidence: `PASS`.
- Real Provider evidence: `NOT_RUN`, prohibited by this task.
- Authoritative local database migration/runtime mutation: `NOT_RUN`.
- Deployment and human UAT: `NOT_RUN`.

### External Actions Observed

- DataForSEO calls: `0`.
- Browser/SafeFetch calls: `0`.
- Paid AI calls: `0`.
- Gmail calls: `0`.
- Provider cost: `$0`.

Phase 7 exit criterion is satisfied: every non-policy AI failure covered by the
state machine leaves an editable basic draft. Phase 8 was not started.

## 2026-08-18 Budget Fallback Correction

The original result incorrectly classified `BUDGET_EXCEEDED` as a policy
failure. The authoritative product contract classifies it as a non-policy
failure that must leave an editable basic draft.

The correction covers the complete local request path:

- the API readiness preflight no longer rejects a known AI readiness state
  before a Draft Job can be persisted;
- the Worker reserves budget at the actual AI-generation boundary, after the
  Draft Job has entered the recoverable workflow;
- a failed budget reservation becomes `TEMPLATE_FALLBACK` with
  `fallbackReason=BUDGET_EXCEEDED`;
- no retry is scheduled and the Provider transport is not reached;
- `REFUSED` and `POLICY_VIOLATION` remain blocked without silent fallback.

Correction verification:

- focused tests:
  `npx vitest run test/unit/draft-generation-workflow.test.ts test/backlinks/api/draft-jobs-route.test.ts test/unit/production-runtime.test.ts`
  -> `PASS`, 3 files and 21 tests;
- targeted ESLint -> `PASS`;
- backend TypeScript typecheck -> `PASS`;
- backend production build -> `PASS`, build ID
  `local-product-4ce0e0e5786e9f154b416203`;
- scoped `git diff --check` -> `PASS`, with Windows line-ending warnings only;
- Provider calls, database mutation, and Temporal business-job creation: `0`.
