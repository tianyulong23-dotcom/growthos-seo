# Agent send adapter: step 1

## Scope and ownership

- Task: AGENT-SEND-STEP1-20260914.
- Authority: the user's approved sequential coding plan in this conversation.
- Repository: `C:/Users/DELL/Documents/缝合/john3947-seo-main`.
- Branch: `main`; baseline HEAD: `506d88fac0fa81503e54aebdfc4ac9e68974997b`.
- Baseline: 44 existing dirty/untracked files outside checkpoints. Hashes and
  before-images of owned existing files are under
  `.codex-checkpoints/agent-send-step1-20260914/`.
- Owned production files: Agent `backlinks_send.py`, `backlinks_drafts.py`,
  `tools.py`, `activities.py`, `model_gateway.py`, and its progress label in `progress.py`.
- Owned tests: `test_agent_backlinks_send.py`, the obsolete no-send assertion in
  `test_agent_backlinks_drafts.py`, and tool invalidation membership in
  `test_agent_tools.py`.
- Do not modify Core, frontend, database schemas, Gmail configuration, recommendation
  generation, existing queues, or unrelated dirty changes.
- Real provider calls: zero. Real sends, business jobs, migrations, service
  restarts, commits and pushes: not authorized.

## Checkpoints

1. Inspect existing send intent contract and establish baseline.
2. Add a default-denied Agent adapter to the existing Core send intent endpoint.
   Keep model arguments separate from server-held confirmation.
3. Verify synthetic submission, isolation, rejection, replay, response validation,
   and adjacent Agent/Core tests. Record results here.

## Stop boundary

Stop after step 1's adapter and tests. Project creation triggers, batch orchestration,
durable authorization storage/UI, automatic approval, and real-provider acceptance
belong to subsequent steps. Do not treat this adapter as completed automation.

The production registry has no confirmation source and must reject submissions.
Only tests supply synthetic server-held confirmations. No environment flag,
model-supplied confirmation, or chat instruction enables sending.

## Results

### IMPLEMENTED

- Registered `submit_backlink_email` through the existing ToolRegistry and Agent
  activity path, including durable project/organization delegation and operation ID.
- The tool calls the existing
  `POST /api/v1/projects/:key/backlinks/drafts/:id/send-intents` contract.
  Core owns policy, persistence, outbox, quota, pacing, retries and reconciliation.
- Tool arguments contain only target IDs, versions, purpose and follow-up index.
  Model-provided authority, recipients, body content, snapshots and confirmation are
  rejected. No approval tool or authorization issuing endpoint was added.
- A trusted server confirmation source is an injected interface with no production
  implementation or default instance. Missing source/record blocks before Core HTTP.
  Tests alone inject synthetic records. This is NOT an automatic authorization system.
- Confirmation must match organization, workspace, project, user, operation and target,
  remain unexpired, and reference its readiness snapshot. Execution reloads the record
  and checks its fingerprint against preparation; revoked or changed records block.
  The existing Core contract remains responsible for authoritative readiness validation.
- The adapter accepts only the existing 201/READY receipt with matching draft/version/
  contact and scoped metadata. READY means task accepted, not provider acceptance,
  delivery or receipt by the seller.
- Response loss, HTTP errors or invalid receipts return non-retryable
  `BACKLINKS_SEND_SUBMISSION_UNVERIFIED`; subsequent action is to read existing send
  intents, not generate a new operation ID or blindly submit again.
- Existing draft/preflight HTTP success statuses are unchanged. The shared request
  helper accepts an explicit status tuple only for the new send adapter.

### TESTED

Final API command, from `backend/api`:

```powershell
.venv/Scripts/python.exe -m pytest tests/test_agent_backlinks_send.py tests/test_agent_backlinks_drafts.py tests/test_agent_backlinks_read.py tests/test_agent_email_dry_run.py tests/test_agent_tools.py tests/test_agent_activities.py tests/test_agent_model_gateway.py tests/test_agent_api.py tests/test_agent_security.py -q
```

Result: **529 passed**. Includes **63 new send-adapter tests**, default denial,
model authority injection, scope/version/account mismatch, expiry/revocation,
changed confirmation, invalid responses, 201-only contract, exact-body/key replay,
lost-response readback, and Agent activity scope/result replay.

Core command, from `backend/core`:

```powershell
node node_modules/vitest/vitest.mjs run test/unit/gmail-send-intent-command.test.ts test/unit/gmail-send-intent-repository.test.ts test/unit/send-intent.query.test.ts test/backlinks/api/send-intent-route.test.ts
```

Result: **4 files / 55 tests passed**. No Core source or test changes.

- Ruff: both new Python files pass. The seven existing owned files retain exactly
  the same 20 code/message lint findings as their before-images; no unrelated lint
  cleanup was performed.
- Scoped Git whitespace checks pass with Windows CR-at-EOL handling.
- All **37 unrelated dirty/untracked files** match their baseline SHA-256 hashes.
  Seven existing files were changed additively and three files were added (adapter,
  tests, this report). No unrelated source/status entries were introduced.

### Remaining proof and next boundary

- No real network/model/Gmail send, business database job, service restart, migration,
  commit or push was performed.
- New adapter HTTP tests use MockTransport with a real-network prohibition.
  Simulated confirmation/submission is not real-provider or full-product acceptance.
- Production construction supplies no confirmation source and therefore remains
  default-denied even when the user asks the Agent to send.
- Step 2 must connect project readiness, V2 generation, opportunity/contact selection
  and batch drafts to the existing durable work. Do not replace existing queues.
- Subsequent work must implement trusted authorization persistence and its UI/service
  contract; automatic project authorization must not be relabeled as a human confirmation.
  It needs an explicit compatible Core authorization contract before enabling real sends.
- Current per-run delegation and readiness snapshots are short-lived. Long-running
  batches must not extend them themselves or rely on an open chat session.
- Implement and validate automation without real sends first. Only after the user
  accepts the functionality and authorizes the test recipients should real sending
  and Email Center/provider evidence be tested.

**Step 1: IMPLEMENTED / TESTED. Full automation and REAL_PROVIDER_VERIFIED: not complete.**
