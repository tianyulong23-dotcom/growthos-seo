# PB-D-MAIL-REPLY Result

Status: INTEGRATED
Workspace: C:\Users\DELL\Documents\缝合\john3947-seo
Handoff updated at: 2026-07-29T15:38:53+08:00
Task: BL-AI-161 prerequisite fact completion - PB-D Draft/Reply Correction
Canonical State: integrated by the BL-AI-160 Phase 08 controller

## Current BL-AI-161 Prerequisite Fact Completion Handoff

### Status And Scope

- Final status: `INTEGRATED`.
- This is a prerequisite correction for BL-AI-161, not a new BL-AI task
  number. BL-AI-162 was not started.
- Work was limited to the existing Draft approval and Reply assignment
  repositories, their Unit/PostgreSQL tests, and this PB-D Result.
- No public API, shared Event Registry, shared OpenAPI, migration file or
  migration number, Canonical State, frontend, production configuration, or
  provider adapter was changed.
- No metric-specific shadow event was created. Both corrections reuse
  `backlink_lifecycle_events` and the linked `backlink_audit_events`.

### Implemented Behavior

- Draft approval now performs the aggregate update, immutable lifecycle fact
  append, and linked audit append in one PostgreSQL statement.
- The Draft approval fact uses event type `draft.approval.recorded` and
  contract version `draft-approval-fact.v1`. Its payload contains:
  `draftId`, `approvedVersionId`, `previousStatus`, `nextStatus`,
  `previousAggregateVersion`, `nextAggregateVersion`, `actorId`,
  `occurredAt`, and `contractVersion`.
- Draft optimistic version checks and row locking serialize concurrent
  approval attempts. A stale retry or idempotent replay returns a version
  conflict and does not append another fact.
- A Draft audit insertion failure rolls back the approval update and
  lifecycle append.
- Reply AUTO and MANUAL assignment now build the same
  `reply-assignment-fact.v1` payload and append the same
  `reply.assignment.recorded` lifecycle fact.
- The Reply assignment payload contains: `inboundMessageId`,
  `providerMessageId`, `providerThreadId`, `matchCandidateId`,
  `opportunityId`, `matchAuthority`, `confidence`, `ruleVersion`, `actorId`,
  `occurredAt`, and `contractVersion`.
- AUTO uses `matchAuthority: AUTO`; manual confirmation uses
  `matchAuthority: MANUAL` while preserving the existing
  `reply_match_candidate.confirmed` audit action and its before/after data.
- `REVIEW_REQUIRED` and successful `UNMATCHED` results do not append an
  assignment fact.
- AUTO candidate changes, inbound aggregate changes, assignment fact, and
  audit are inside the existing Gmail tenant transaction. Manual candidate
  confirmation, inbound aggregate change, assignment fact, and audit use the
  same transaction boundary.
- A repeated AUTO assignment or stale manual confirmation is rejected before
  another fact is appended. A lifecycle insertion failure rolls back the
  inbound aggregate and candidate writes.

### Exact Changed Files

- `src/modules/backlinks/application/repositories/draft-generation.repository.ts`
- `src/modules/backlinks/application/services/reply-match.repository.ts`
- `test/unit/pb-d-fact-contract.test.ts`
- `test/backlinks/integration/draft-migration.test.ts`
- `test/backlinks/integration/reply-match-repository.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### RED And Intermediate Evidence

- Initial RED command:
  `npx vitest run test/unit/pb-d-fact-contract.test.ts test/backlinks/integration/draft-migration.test.ts test/backlinks/integration/reply-match-repository.test.ts`
  - Exit code: `1`.
  - Result: 3 files failed; 8 tests failed and 6 passed.
  - The Draft approval SQL had no lifecycle/audit transaction, the Reply fact
    builder did not exist, fact counts remained zero, and forced fact/audit
    failures did not roll back the aggregate changes.
- First implementation rerun used the same command:
  - Exit code: `1`.
  - Result: 2 files failed and 1 passed; 6 tests failed and 8 passed.
  - PostgreSQL rejected ambiguous contract-version and UUID/text parameters.
    Explicit SQL casts were added without changing behavior or schema.

### Focused Final Verification

- Command:
  `npx vitest run test/unit/pb-d-fact-contract.test.ts test/backlinks/integration/draft-migration.test.ts test/backlinks/integration/reply-match-repository.test.ts`
- Exit code: `0`.
- Result: 3 files and 15 tests passed.
- The focused PostgreSQL coverage proves:
  - Draft fact payload, linked audit, idempotent replay, workspace isolation,
    concurrent version conflict, and transaction rollback;
  - common AUTO/MANUAL Reply fact payload, preserved manual audit,
    REVIEW_REQUIRED/UNMATCHED exclusion, workspace isolation, retry
    deduplication, and transaction rollback.

### Complete Core Verification

- `npm run typecheck`
  - Exit code: `0`.
- `npm run lint`
  - Exit code: `0`.
- `npm run migration:backlinks:check`
  - Exit code: `0`.
  - Result: 22 migration files valid through `0029`.
- `npm run test:backlinks:unit`
  - Exit code: `0`.
  - Result: 62 files and 370 tests passed.
- `npm run test:backlinks:api`
  - Exit code: `0`.
  - Result: 26 files and 80 tests passed.
- `npm run test:backlinks:contract`
  - Exit code: `0`.
  - Result: 20 files and 144 tests passed.
- `npm run test:backlinks:integration`
  - Exit code: `0`.
  - Result: 44 files passed and 4 skipped; 157 tests passed and 13 skipped.
- `npm run test:backlinks:security`
  - Exit code: `0`.
  - Result: 7 files and 97 tests passed.
- `npm run test:backlinks:resilience`
  - Exit code: `0`.
  - Result: 1 file and 3 tests passed.

### Integration Acceptance

- The BL-AI-160 Phase 08 controller reaccepted this correction after both
  prerequisite patch sets landed.
- Draft approval is fully reconstructible from the immutable
  `draft.approval.recorded` fact snapshot.
- AUTO and MANUAL Reply assignment use the same
  `reply-assignment-fact.v1` contract.
- The combined correction regression passed 4 files and 27 tests, and the
  fresh full Core gate passed Unit 370, API 80, Contract 144, Integration 157,
  Security 97, and Resilience 3 tests.
- No public API, Event Registry, migration, provider behavior, or production
  resource was changed by integration.

### Shared Change Request

- None required for this correction.
- No public route, API contract, shared OpenAPI, Event Registry, database
  migration, dependency, or production configuration change is requested.

### Canonical State, Side Effects, And Unproved Items

- Canonical State was unchanged before and after this correction:
  - SHA-256:
    `F393E65970A37E7FE300BD876D1DF613F0FA8DCE0DFFD724379A0F1C17F75A28`
  - Length: `533500` bytes.
  - Last write time UTC: `2026-07-29T06:29:36.5754422Z`.
- No real Gmail, Google Pub/Sub, DataForSEO, AI provider, Browser, or
  production database call was made.
- PostgreSQL integration evidence used disposable local Testcontainers
  databases and did not persist production data.
- No commit, push, merge, rebase, or reset was performed.
- Not proved in this correction:
  - production PostgreSQL behavior under real multi-instance traffic;
  - external consumers reading the new fact payloads;
  - database-wide privilege prevention of direct lifecycle-row mutation.
    PB-D repository paths only append lifecycle facts; global role hardening
    would require a separately authorized shared migration/change;
  - the 4 skipped integration files and 13 skipped integration tests whose
    existing environment conditions were not enabled.

## Current BL-AI-141 Handoff

### Status

- Final status: `HANDOFF_READY`.
- This round executed BL-AI-141 only. BL-AI-142 was not started.
- BL-AI-138 and BL-AI-139 Core handoff remains complete. PB-FE-MAIL
  records BL-AI-140 as `HANDOFF_READY`.

### Preconditions And Boundary Audit

- The V1.4.1 total-control index, PB-D manual, V1.0 BL-AI-141 card,
  Canonical State, current PB-D Result, and PB-FE-MAIL Result were reviewed
  before implementation.
- The verified dependency route is BL-AI-139 Core plus BL-AI-140 frontend
  synchronization before BL-AI-141. Those handoffs were present.
- Existing Gmail incremental sync uses its durable cursor and the existing
  Gmail Sync Adapter remains default-off.
- Work stayed inside PB-D Mail/Gmail Sync/Webhook implementation, matching
  tests, and this Result file.
- Shared public Gateway registration, global route registration, shared
  OpenAPI, shared Event Registry, global Outbox relay registration, Canonical
  State, frontend, Crawler, DataForSEO, dependency files, and production
  configuration were not modified.

### Implemented Behavior

- Added a strict Google Pub/Sub envelope and Gmail notification parser.
  Invalid base64, invalid JSON, invalid email, invalid History ID, invalid
  message ID, and invalid subscription resources fail closed.
- Added a default-off Gmail Push identity verifier shell. When explicitly
  enabled it requires an injected cryptographic signed-token verifier, exact
  audience, exact authorized service-account email, accepted Google issuer,
  verified email, valid subject, non-expired token, and bounded issued-at
  time.
- Added a default-off module-private Gmail Push Webhook workflow.
  Authentication runs before payload parsing, target resolution, or Outbox
  writes.
- Target authorization requires an injected resolver to match both the
  Pub/Sub subscription and normalized notification email to one authorized
  tenant/project Gmail sync target.
- Provider message ID plus subscription produce a stable SHA-256
  idempotency key and deterministic aggregate UUID. Existing Outbox database
  uniqueness returns the original event for repeat delivery.
- The Outbox payload is only
  `backlinks.gmail-incremental-sync.requested.v1`. It contains tenant,
  project, connection, and `GMAIL_PUSH` trigger fields only. Provider email,
  History ID, Pub/Sub message ID, mail body, headers, and business facts are
  excluded.
- Added a module-private Outbox relay that validates event type, schema
  version, aggregate version, and tenant scope before starting incremental
  Gmail sync from the durable cursor context.
- Added a module-private Fastify route at
  `POST /api/v1/backlinks/mail/gmail-push`. It returns `202` for both first
  and duplicate valid delivery, and maps malformed, forged, unauthorized,
  disabled, and internal failures without token or notification leakage.

### Exact Changed Files

- `src/modules/backlinks/adapters/gmail/sync-push-parser.ts`
- `src/modules/backlinks/adapters/gmail/sync-push-verifier.ts`
- `src/modules/backlinks/application/workflows/mail-push-webhook.ts`
- `src/modules/backlinks/application/workflows/mail-push-outbox-relay.ts`
- `src/modules/backlinks/api/gmail-mail-push.schema.ts`
- `src/modules/backlinks/api/gmail-mail-push.route.ts`
- `test/contract/gmail-sync-push-verifier.test.ts`
- `test/unit/gmail-push-webhook.test.ts`
- `test/backlinks/api/gmail-mail-push-route.test.ts`
- `test/backlinks/integration/gmail-mail-push-outbox.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### RED Evidence

- Command:
  `npx vitest run test/contract/gmail-sync-push-verifier.test.ts test/unit/gmail-push-webhook.test.ts test/backlinks/api/gmail-mail-push-route.test.ts test/backlinks/integration/gmail-mail-push-outbox.test.ts`
- Exit code: `1`.
- Result: four suites failed to import the not-yet-created BL-AI-141
  verifier, Webhook workflow, relay, and route modules.
- First implementation lint command:
  `npm run lint -- --quiet`
- Exit code: `1`.
- Result: the domain-layer Zod restriction rejected the first parser
  location. The parser was moved into the allowed Gmail Adapter path before
  final verification.

### Focused Final Verification

- `npx vitest run test/contract/gmail-sync-push-verifier.test.ts test/unit/gmail-push-webhook.test.ts test/backlinks/api/gmail-mail-push-route.test.ts`
  - Exit code: `0`.
  - Result: 3 files and 26 tests passed.
- `npx vitest run test/backlinks/integration/gmail-mail-push-outbox.test.ts`
  - Exit code: `0`.
  - Result: 1 file and 1 PostgreSQL Outbox deduplication test passed.

### Complete Core Verification

- `npm run typecheck`
  - Exit code: `0`.
- `npm run lint`
  - Exit code: `0`.
- `npm run migration:backlinks:check`
  - Exit code: `0`.
  - Result: 22 migration files valid through `0029`.
- `npm run test:backlinks:unit`
  - Exit code: `0`.
  - Result: 59 files and 356 tests passed.
- `npm run test:backlinks:api`
  - Exit code: `0`.
  - Result: 26 files and 78 tests passed.
- `npm run test:backlinks:contract`
  - Exit code: `0`.
  - Result: 20 files and 144 tests passed.
- `npm run test:backlinks:integration`
  - Exit code: `0`.
  - Result: 44 files passed, 4 skipped; 147 tests passed, 13 skipped.
- `npm run test:backlinks:security`
  - Exit code: `0`.
  - Result: 6 files and 95 tests passed.
- `npm run test:backlinks:resilience`
  - Exit code: `0`.
  - Result: 1 file and 3 tests passed.

### Shared-Change Request

`SCR-PB-D-BL-AI-141-01` is required from the shared-stack owners:

- Register the module-private
  `POST /api/v1/backlinks/mail/gmail-push` route in the public Gateway and
  shared global route assembly.
- Add the approved shared OpenAPI operation without changing the PB-D route
  contract.
- Provide the production Google-signed OIDC token verifier and inject exact
  audience and authorized Pub/Sub service-account identity.
- Provide the authorized subscription/email-to-active-sync-target resolver.
- Register `backlinks.gmail-incremental-sync.requested.v1` in the shared
  Event Registry and wire the module-private relay to the approved
  incremental Gmail sync starter.
- Preserve default-off flags through shared configuration and require a
  separately authorized canary before any real Gmail or Pub/Sub traffic.

PB-D did not directly make any of these protected shared changes.

### Canonical State, Side Effects, And Unproved Items

- Canonical State remained unchanged:
  - SHA-256:
    `A2F6F62CAFF8D523C9AE2992D2A2E4FABF7B4837DF34A06479FCB8E2790DA18E`
  - Length: `526752` bytes.
  - Last write time UTC: `2026-07-29T02:30:40.3262271Z`.
- No real Gmail, Google Pub/Sub, DataForSEO, AI provider, or production
  database call was made.
- The focused and complete integration gates used disposable local
  Testcontainers PostgreSQL instances, which were stopped by their harness.
- No dependency, lockfile, production configuration, frontend, Crawler, or
  DataForSEO file was changed by BL-AI-141.
- No commit, push, merge, rebase, or reset was performed.
- Not proved in this block:
  - real public-Gateway delivery from Google Pub/Sub;
  - production Google signature/JWK verification and token rotation;
  - production subscription/email target-resolution wiring;
  - shared OpenAPI, Event Registry, and global relay registration;
  - a real Gmail watch lifecycle or real incremental Gmail API call;
  - production multi-instance load behavior and provider redelivery timing;
  - the 4 skipped integration files and 13 skipped integration tests whose
    existing environment conditions were not enabled.

## Current BL-AI-138 Through BL-AI-139 Handoff

### Preconditions

- The existing BL-AI-137 rule classifier, PB-D policies, workflow,
  repositories, append-only audit events, and focused tests were reviewed
  before extending the flow.
- BL-AI-138 was completed before BL-AI-139. BL-AI-140 and later PB-D task
  numbers were not executed in this block.
- Existing manual match decisions remain authoritative. Neither task enables
  automatic reply sending.
- The work stayed within the PB-D implementation, test, and Result paths.
  Shared server registration, shared OpenAPI, Canonical State, and production
  configuration were not edited.

### Exact Changed Files

- `src/modules/backlinks/application/services/reply-opportunity-projection.ts`
- `src/modules/backlinks/application/queries/reply-mail.query.ts`
- `src/modules/backlinks/adapters/gmail/sanitizer-mail-content-reader.ts`
- `src/modules/backlinks/api/reply-mail.schema.ts`
- `src/modules/backlinks/api/reply-mail.route.ts`
- `test/unit/reply-opportunity-projection.test.ts`
- `test/unit/reply-mail.query.test.ts`
- `test/unit/reply-mail-content-reader.test.ts`
- `test/backlinks/api/reply-mail-route.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### Implemented Boundary

- BL-AI-138 projects the deterministic BL-AI-137 rule classification into the
  existing Opportunity lifecycle and append-only audit flow while preserving
  prior manual decisions.
- BL-AI-139 adds project-scoped reply-mail list, detail, and thread query
  contracts with cursor pagination and match-status filtering.
- Reply content prefers plain text. HTML can be returned only when the object
  reader marks it both sanitized and safe for HTML rendering.
- Object reads remain project-scoped. The API DTO does not expose raw storage
  keys, provider tokens, or unsanitized HTML.
- The route is module-private and independently registrable. Global Core
  server registration and the shared OpenAPI document remain outside this
  task's allowed paths.

### Failure-First and Focused Verification

| Command | Exit code | Result |
| --- | ---: | --- |
| `npx vitest run test/unit/reply-mail.query.test.ts test/backlinks/api/reply-mail-route.test.ts` before implementation | `1` | Failed because the BL-AI-139 query and route modules did not exist. |
| `npx vitest run test/unit/reply-mail-content-reader.test.ts` before implementation | `1` | Failed because the sanitizer-aware content reader did not exist. |
| `npx vitest run test/unit/reply-opportunity-projection.test.ts` | `0` | BL-AI-138 focused coverage passed, `6/6`. |
| `npx vitest run test/unit/reply-mail.query.test.ts test/unit/reply-mail-content-reader.test.ts test/backlinks/api/reply-mail-route.test.ts` | `0` | BL-AI-139 focused coverage passed, `10/10`. |
| `npx vitest run test/unit/reply-opportunity-projection.test.ts test/unit/reply-mail.query.test.ts test/unit/reply-mail-content-reader.test.ts test/backlinks/api/reply-mail-route.test.ts` | `0` | Combined BL-AI-138/139 rerun passed, 4 files and `16/16` tests. |
| `npm run typecheck` | `0` | Core TypeScript gate passed. |
| `npm run lint` | `0` | Core lint gate passed. |

### Full Core Verification

| Command | Exit code | Result |
| --- | ---: | --- |
| `npm run verify:backlinks` | `0` | Completed in 135.6 seconds. Source manifest `26`; dependency and license checks passed with `642` packages; OpenAPI baseline `29` paths; migration gate `22` files through `0029`; unit `56` files / `347` tests; API `25` files / `73` tests; contract `19` files / `128` tests; integration `43` passed and `4` skipped files, `145` passed and `13` skipped tests; security `6` files / `95` tests; resilience `1` file / `3` tests. |

The resilience run emitted the expected
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` warning. It was injected by the test
and did not represent an unhandled gate failure.

### Unproved Items and External Effects

- Global Core server registration, shared OpenAPI publication, public FastAPI
  gateway wiring, and product-level end-to-end behavior remain unproved.
- The BL-AI-135 candidate-confirmation route and the BL-AI-139 mail route both
  remain module-private until a shared integration task edits the protected
  route and contract paths.
- Live Gmail, external object storage, DataForSEO, AI providers, and production
  databases were not called. DataForSEO remains present and unchanged.
- Disposable PostgreSQL used by the Core verification was stopped by the test
  harness. No Docker container remained running after the gate.
- No commit, push, merge, rebase, or reset was performed.
- PB-D did not write Canonical State. During this run, another workspace change
  changed its SHA-256 from
  `464037B94E7717194C3D7DE2B89D54B4EB2C0C2DAC36A0824C7BBAFD5A4F9B20`
  to
  `A2F6F62CAFF8D523C9AE2992D2A2E4FABF7B4837DF34A06479FCB8E2790DA18E`.
  The file still contains no BL-AI-137 through BL-AI-140 row, and this task did
  not revert the concurrent change.

The BL-AI-137 section below is retained as historical evidence.

## Current BL-AI-137 Handoff

### Preconditions

- The V1.0 task card and V1.4.1 PB-D manual both require BL-AI-136 before
  BL-AI-137 and limit BL-AI-137 to a Domain service plus tests.
- Canonical State records BL-AI-136 as `INTEGRATED`.
- Migration `0027` and the append-only Reply Classification version table were
  already integrated before this task started.
- The PB-D Result was already `HANDOFF_READY` for BL-AI-136.
- This round executed BL-AI-137 only. BL-AI-138 was not started.

### Exact Changed Files

- `src/modules/backlinks/domain/replies/classification.ts`
- `test/unit/reply-classification.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### Implemented Boundary

- Added deterministic rule classification codes `POSITIVE`, `NEGATIVE`,
  `QUESTION`, `OUT_OF_OFFICE`, and `UNKNOWN`.
- Rule precedence is `OUT_OF_OFFICE -> NEGATIVE -> QUESTION -> POSITIVE ->
  UNKNOWN`, so explicit absence and rejection/opt-out signals cannot be
  overridden by lower-priority interest or question text.
- Each result includes `classifierType=RULE`, version
  `reply-classification-rules-v1`, confidence, one explainable rule ID,
  source, matched text, and source offsets.
- Generic automatic acknowledgements are not treated as out-of-office, and
  declarative uses of question words are not treated as questions.
- Every result sets `autoSendAllowed=false`. The service has no repository,
  workflow, API, Gmail, AI, database, or sending dependency and produces no
  external side effect.

### Failure-First and Focused Verification

| Command | Exit code | Result |
|---|---:|---|
| First `npx vitest run test/unit/reply-classification.test.ts` | `1` | Expected RED: `classification.js` did not exist; 0 tests collected |
| Misclassification regression `npx vitest run test/unit/reply-classification.test.ts` | `1` | Expected RED: broad question-word and generic automatic-reply rules caused 2 failures |
| Final `npx vitest run test/unit/reply-classification.test.ts` | `0` | 1 file and 10/10 tests passed |
| `npx eslint src/modules/backlinks/domain/replies/classification.ts test/unit/reply-classification.test.ts` | `0` | Focused lint passed |
| `npm run typecheck` | `0` | TypeScript passed |

### Final Core Verification

The first full run against the final source reached Integration but exited `1`
because two existing suites timed out in `afterAll` while releasing disposable
PostgreSQL resources:

- `test/backlinks/integration/foundation.test.ts`
- `test/backlinks/integration/gmail-auth-repositories.test.ts`

Both suites then passed independently with `--maxWorkers=1` (2/2 and 3/3,
exit `0`). A subsequent unchanged full run passed:

| Command | Exit code | Result |
|---|---:|---|
| `npm run typecheck` | `0` | Passed |
| `npm run lint` | `0` | Passed |
| `npm run source:manifest:check` | `0` | 26 source-manifest records valid |
| `npm run dependencies:allowlist` | `0` | Dependency allowlist valid |
| `npm run licenses:check` | `0` | 642 packages valid |
| `npm run openapi:backlinks:check` | `0` | Concurrent shared baseline valid at 29 paths |
| `npm run migration:backlinks:check` | `0` | Concurrent shared baseline valid at 22 migrations through `0029` |
| `npm run test:backlinks:unit` | `0` | 53 files and 334/334 tests passed |
| `npm run test:backlinks:api` | `0` | 24 files and 70/70 tests passed |
| `npm run test:backlinks:contract` | `0` | 19 files and 128/128 tests passed |
| `npm run test:backlinks:integration` | `0` | 43 files passed, 4 skipped; 145 tests passed and 13 environment-gated tests skipped |
| `npm run test:backlinks:security` | `0` | 6 files and 95/95 tests passed |
| `npm run test:backlinks:resilience` | `0` | 1 file and 3/3 tests passed |
| Final `npm run verify:backlinks` | `0` | All required Core gates passed |

The Integration output included the intentional
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` fixture. The enclosing Integration
suite exited `0`.

### Unproved Items and External Effects

- The rules are an English deterministic baseline, not a production-calibrated
  classifier. Precision, recall, coverage, multilingual behavior, and the
  required 300-message redacted Gold Set remain unproved.
- Header/MIME classification of `AUTO_REPLY` and `BOUNCE`, classification
  persistence, replay/version orchestration, AI fallback, and Opportunity
  projection are outside BL-AI-137 and were not implemented.
- No real Gmail, DataForSEO, AI provider, credential, object store, production
  database, or production API call occurred. DataForSEO remains present and
  unchanged.
- The post-gate `docker ps` check at `2026-07-29T09:38:20+08:00` returned no
  running containers. A later Result-validation check showed `uv` and
  `seo4-int-004-pg` containers started by concurrent work; BL-AI-137 did not
  start, stop, or modify them.
- Parallel work advanced shared OpenAPI and migration baselines during this
  task. PB-D did not edit those shared surfaces; the final gate verified the
  resulting 29-path / `0029` baseline.
- Canonical State was not modified. Its final SHA-256 remained
  `464037B94E7717194C3D7DE2B89D54B4EB2C0C2DAC36A0824C7BBAFD5A4F9B20`,
  with `LastWriteTime` still `2026-07-29T09:16:04.0429731+08:00`.
- Package/lock files, source manifest, NOTICE, SBOM, shared OpenAPI, migration
  files, frontend, crawler, FastAPI, and DataForSEO files were not modified by
  BL-AI-137.
- Git commit, push, merge, rebase, and reset: none.

## Current BL-AI-133 Through BL-AI-136 Handoff

### Preconditions and Serial Gate

- BL-AI-132 was already `HANDOFF_READY`, and the approved DOMPurify/jsdom
  dependency integration required by BL-AI-133 was present before this resumed
  execution.
- Tasks were executed serially. BL-AI-134 started only after BL-AI-133 passed
  its full Core gate; BL-AI-135 started only after BL-AI-134 passed; BL-AI-136
  started only after BL-AI-135 passed.
- BL-AI-133, BL-AI-134, and BL-AI-135 each reached `HANDOFF_READY` locally.
- BL-AI-136 implementation and its disposable PostgreSQL functional gate pass.
  The integration controller registered the protected `backlinks-0027`
  deployment step, advanced the Backlinks head to `0027`, updated the
  authorized migration coverage and PostgreSQL 18 runner, and reran the
  mandatory gates. The final board status is now `HANDOFF_READY`.

### Exact Changed Files

BL-AI-133:

- `src/modules/backlinks/adapters/gmail/sanitizer.ts`
- `test/fixtures/mail/malicious-email.html`
- `test/unit/gmail-html-sanitizer.test.ts`

BL-AI-134:

- `src/modules/backlinks/domain/replies/matching.ts`
- `test/unit/reply-matching.test.ts`

BL-AI-135:

- `src/modules/backlinks/application/services/reply-match.repository.ts`
- `src/modules/backlinks/application/commands/reply-match.command.ts`
- `src/modules/backlinks/api/reply-match.route.ts`
- `test/backlinks/api/reply-match-route.test.ts`
- `test/backlinks/integration/reply-match-repository.test.ts`

BL-AI-136:

- `src/modules/backlinks/db/schema/negotiation-facts.ts`
- `src/modules/backlinks/db/migrations/0027_backlink_negotiation_facts.sql`
- `test/backlinks/integration/negotiation-facts-migration.test.ts`

Handoff:

- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### Implemented Boundary

- BL-AI-133 sanitizes untrusted parsed Gmail HTML with the approved
  DOMPurify/jsdom runtime. Active tags, event attributes, style payloads,
  dangerous URLs, remote tracking resources, SVG/MathML/forms, and iframe-like
  content are excluded; failure falls back to escaped plain text.
- BL-AI-134 scopes matching by organization, workspace, website project, and
  Gmail connection. Provider thread, `In-Reply-To`, and `References` are strong
  evidence. Subject/body/contact/participant/time evidence can only produce a
  review candidate; subject alone never auto-assigns an Opportunity.
- BL-AI-135 persists candidates under the same tenant/project scope. Low
  confidence remains `CANDIDATES_READY` and requires manual confirmation. The
  confirmation operation uses expected state, is single-use, and appends an
  integrity-linked `reply_match_candidate.confirmed` audit record atomically.
- BL-AI-136 adds append-only
  `backlink_reply_classification_versions` and
  `backlink_negotiation_fact_versions`. Both use composite tenant foreign keys,
  forced RLS, version uniqueness, and writer `SELECT, INSERT` only.
- Negotiation facts distinguish `INFERRED/PENDING` extraction rows from
  `MANUAL/CONFIRMED|REJECTED|SUPERSEDED` decision rows. Reclassification and
  re-extraction append new versions; neither can update or delete an existing
  manual fact.
- Migration `0027_backlink_negotiation_facts.sql` SHA-256 is
  `37ba5f6f80ba61a45ff4047c5b80d2d94ad3694c16f0c38026fe124af87f000e`.

### Failure-First and Focused Verification

| Task | Command | Exit code | Result |
|---|---|---:|---|
| 133 | First `npx vitest run test/unit/gmail-html-sanitizer.test.ts` | `1` | Expected RED: sanitizer module absent; 0 tests collected |
| 133 | First post-implementation `npm run typecheck` | `1` | DOM library typing mismatch exposed and corrected without changing behavior |
| 133 | Final focused Unit, typecheck, and focused ESLint | `0` | 1/1 sanitizer test passed |
| 133 | `npm run verify:backlinks` | `0` | Unit 238/238; API 59/59; Contract 128/128; Integration 124 passed and 13 skipped; Security 95/95; Resilience 3/3 |
| 134 | First `npx vitest run test/unit/reply-matching.test.ts` | `1` | Expected RED: matching module absent |
| 134 | First post-implementation focused Unit | `1` | Time-only evidence was incorrectly retained as a candidate; corrected |
| 134 | Final focused Unit, typecheck, and focused ESLint | `0` | 6/6 matcher tests passed |
| 134 | `npm run verify:backlinks` | `0` | Unit 244/244; API 59/59; Contract 128/128; Integration 124 passed and 13 skipped; Security 95/95; Resilience 3/3 |
| 135 | First API and PostgreSQL focused tests | `1` | Expected RED: command/repository modules absent |
| 135 | First post-implementation API and typecheck | `1` | API 2/3 and readonly response typing failed; corrected |
| 135 | `npx vitest run test/backlinks/api/reply-match-route.test.ts` | `0` | 3/3 passed |
| 135 | `npx vitest run test/backlinks/integration/reply-match-repository.test.ts` | `0` | 2/2 passed in disposable PostgreSQL |
| 135 | `npm run typecheck` and focused ESLint | `0` | Passed |
| 135 | `npm run verify:backlinks` | `0` | Unit 244/244; API 62/62; Contract 128/128; Integration 126 passed and 13 skipped; Security 95/95; Resilience 3/3 |
| 136 | First `npx vitest run test/backlinks/integration/negotiation-facts-migration.test.ts` | `1` | Expected RED: Schema module absent; 0 tests collected |
| 136 | First post-implementation focused PostgreSQL test | `1` | 3/4 passed; a transaction-time comparison rejected a valid row and was removed |
| 136 | Final focused PostgreSQL test | `0` | 4/4 passed: Schema/FKs, rerun/manual-fact preservation, cross-project RLS, append-only privileges |
| 136 | `npm run typecheck` | `0` | Passed |
| 136 | `npm run lint` | `0` | Passed |

### Final Core Verification

| Command | Exit code | Result |
|---|---:|---|
| `npm run migration:backlinks:check` | `0` | 20 Backlinks migrations are valid through `0027` |
| `npm run test:backlinks:unit` | `0` | 41 files and 244/244 tests passed |
| `npm run test:backlinks:api` | `0` | 21 files and 62/62 tests passed |
| `npm run test:backlinks:contract` | `0` | 19 files and 128/128 tests passed |
| `npm run test:backlinks:integration` | `0` | 41 files passed, 4 skipped; 130 tests passed and 13 environment-gated tests skipped |
| `npm run test:backlinks:security` | `0` | 6 files and 95/95 tests passed |
| `npm run test:backlinks:resilience` | `0` | 1 file and 3/3 tests passed |
| `powershell -ExecutionPolicy Bypass -File backend/database/tests/verify-postgresql18.ps1` | `0` | PostgreSQL 18.4 clean install, historical upgrade including DataForSEO write compatibility, backup/restore, contracts, ownership, and forced-RLS checks passed |
| `npm run verify:backlinks` | `0` | TypeScript, ESLint, 26-record source manifest, dependency allowlist, 642-package license check, 23-path OpenAPI baseline, 20 migrations through `0027`, and every Backlinks test suite passed |

The Integration output included the intentional
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` fixture. The enclosing Integration
suite exited `0`.

### Shared Change Resolution

The integration controller registered this forward-only step in the protected
database deployment surfaces:

- migration ID: `backlinks-0027`
- path:
  `backend/core/src/modules/backlinks/db/migrations/0027_backlink_negotiation_facts.sql`
- SHA-256:
  `37ba5f6f80ba61a45ff4047c5b80d2d94ad3694c16f0c38026fe124af87f000e`
- prerequisite: `backlinks-0026`
- Backlinks deployment head: `0027`
- authorized FastAPI migration coverage and the PostgreSQL 18 runner now
  include `0027`
- clean install, historical-head upgrade, backup/restore, contracts, ownership,
  and RLS verification passed on PostgreSQL 18.4
- `npm run migration:backlinks:check` and `npm run verify:backlinks` both exit
  `0`

The protected shared-change request is resolved. PB-D did not edit those
surfaces; the integration controller made and verified the changes.

### Unproved Items and External Effects

- The BL-AI-135 route is independently registrable but is not wired into the
  shared private server or shared OpenAPI document because those paths are
  outside PB-D. Production route reachability is therefore not proved.
- Migration `0027` is proved by direct disposable PostgreSQL execution and the
  PostgreSQL 18.4 clean-install, historical-upgrade, backup/restore, contract,
  ownership, and forced-RLS chain. No production database upgrade, rollback
  recovery, backup/restore, or production RLS operation occurred.
- No real Gmail, DataForSEO, AI provider, credential, object store, production
  database, or production API call occurred. DataForSEO remains present and
  unchanged.
- Disposable PostgreSQL/Temporal test infrastructure was stopped; the final
  matching container check returned no running container.
- The integration controller modified Canonical State, the deployment
  manifest, authorized FastAPI migration coverage, and the global PostgreSQL
  18 migration runner/contract only. Package/lock files, source manifest,
  NOTICE, SBOM, shared OpenAPI, frontend, crawler, and DataForSEO files were
  not modified.
- Git commit, push, merge, rebase, and reset: none.

## Historical BL-AI-133 Blocked Handoff

### Preconditions

- BL-AI-132 remains `HANDOFF_READY` with its focused 6/6 parser tests and full
  Core gate exiting `0`.
- The V1.0 and V1.4.1 BL-AI-133 cards require DOMPurify with jsdom and require
  removal of scripts, event handlers, dangerous style URLs, and iframes before
  parsed Gmail HTML can cross the renderable-content boundary.
- PB-D permits sanitizer source, corresponding tests/fixtures, and this Result
  file. It does not permit changes to `package.json`, `package-lock.json`,
  source manifest, third-party notices, SBOM, or Canonical State.

### Changed Files

- `test/fixtures/mail/malicious-email.html`
- `test/unit/gmail-html-sanitizer.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

No sanitizer implementation file was added because the required approved
runtime dependency is absent.

### Failure-First and Core Verification

| Command | Exit code | Result |
|---|---:|---|
| `npm ls dompurify jsdom isomorphic-dompurify --depth=0` | `1` | Core dependency tree is empty for all three packages |
| First `npx vitest run test/unit/gmail-html-sanitizer.test.ts` | `1` | Expected RED: `sanitizer.js` does not exist; 1 suite failed and 0 tests ran |
| `npm run typecheck` | `0` | Existing TypeScript source passed |
| `npm run lint` | `0` | Existing source and the BL-AI-133 RED test passed ESLint |
| `npm run migration:backlinks:check` | `0` | 19 migrations remain valid through `0026` |
| `npm run test:backlinks:unit` | `1` | 39 files and 235/235 existing tests passed; only the new sanitizer suite failed before test collection because the implementation is absent |
| `npm run test:backlinks:api` | `0` | 20 files and 59/59 tests passed |
| `npm run test:backlinks:contract` | `0` | 19 files and 128/128 tests passed |
| `npm run test:backlinks:integration` | `0` | 39 files passed, 4 skipped; 124 tests passed and 13 environment-gated tests skipped |
| `npm run test:backlinks:security` | `0` | 6 files and 95/95 tests passed |
| `npm run test:backlinks:resilience` | `0` | 1 file and 3/3 tests passed |
| `npm run verify:backlinks` | `1` | TypeScript, ESLint, 24-record source manifest, dependency allowlist, 605-package license check, 23-path OpenAPI baseline, and migrations passed; aggregate stopped at the same BL-AI-133 RED Unit suite |

The Integration output included the intentional
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` resilience fixture. The enclosing
Integration suite exited `0`.

### Blocking Dependency Boundary

- A compliant BL-AI-133 implementation cannot import DOMPurify or jsdom from
  the clean Core dependency tree because neither package, nor
  `isomorphic-dompurify`, is installed.
- Installing or pinning the dependency requires the integration controller or
  PB-SHARED-DEPS to update the protected package/lockfile, source manifest,
  third-party notice, and SBOM surfaces and to run their supply-chain gates.
- A custom regex sanitizer, vendored implementation, undeclared transitive
  import, or local `--no-save` install would not satisfy the task card or the
  repository dependency-governance boundary and was not used.
- Required handoff: approve and integrate an exact DOMPurify plus jsdom runtime
  dependency through PB-SHARED-DEPS, including license/provenance and
  deterministic NOTICE/SBOM evidence, then resume BL-AI-133 from the preserved
  RED test.
- Because the board order is `133 -> 134 -> 135 -> 136`, BL-AI-134,
  BL-AI-135, and BL-AI-136 were not executed.

### Integrity, Unproved Items, and External Effects

- Protected SHA-256 values remained unchanged:
  Canonical State
  `5dc2171658d7eeeab63f642dee2a75f859b3566b26e12733d483459100320a8e`,
  `package.json`
  `d508051c3adb4b3db63ed2ab9b97c2434bd7c1487aff4188fdd9dfa98d8e63f9`,
  `package-lock.json`
  `c03d9f1b652826084c181890baf9ba0779aa3f0df58ddf364886610022337316`,
  source manifest
  `581e92b029c2f08626da4d0d011ece65583ecb4f5ec3a15105ab9815a671bbbb`,
  notices
  `36d6d5ed654b8687fa28c59d9b1daabd0d654cfa726016f2c320359d45d59027`,
  and SBOM
  `59e57c4bd67856ae003c61e6b8a9bbf7ac725772694991b696516f592a60a5af`.
- Not proved: HTML sanitization, production XSS safety, live Gmail behavior,
  reply matching, candidate persistence/manual confirmation, negotiation-fact
  persistence, Migration `0027`, or any BL-AI-134 through BL-AI-136 behavior.
- Real network, Gmail, DataForSEO, AI Provider, credentials, and production
  database calls: none. DataForSEO remains present and unchanged.
- Disposable Integration infrastructure was stopped; no matching PostgreSQL or
  Temporal container remained after verification.
- Git commit, push, merge, rebase, and reset: none.

## Historical BL-AI-132 Handoff

### Preconditions

- V1.4.1 routes the completed PB-D Gmail ingestion work through
  `BL-AI-130 -> PB-SHARED-DEPS/BL-AI-131 -> BL-AI-132`.
- Canonical State records BL-AI-131 as integrated. PostalMime `2.7.5`, its
  lockfile entry, source manifest record, notice, and BL-AI-131 MIME fixtures
  were present before BL-AI-132 started.
- The V1.0 BL-AI-132 acceptance is limited to parsing raw MIME into an internal
  `MailMessage`, including multipart content, attachments, transfer encoding,
  nested messages, and stable handling of malformed input.
- BL-AI-133 sanitization is a separate task and was not executed.

### Changed Files

- `src/modules/backlinks/adapters/gmail/message-parser.ts`
- `test/unit/gmail-message-parser.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

### Implemented Boundary

- Added the only authorized parser adapter using PostalMime `2.7.5`, with a
  32 MiB raw-message limit, 256 KiB header limit, and nesting depth limit 64.
- Mapped raw MIME to an immutable, provider-neutral `MailMessage` containing
  parser identity, raw byte size/SHA-256, message relationship headers,
  flattened addresses, subject/date, decoded text, raw HTML marked
  `UNTRUSTED` and unsanitized, and attachment metadata.
- Attachment bytes are used only to calculate byte size and SHA-256, then
  discarded from the returned object. Nested `message/rfc822` parts remain
  untrusted attachment metadata.
- Empty/oversized input and parser failures return stable error codes without
  logging or exposing raw MIME.
- No Repository, Workflow, lifecycle, Opportunity matching, API, database,
  provider, or sanitizer behavior was added.

### Failure-First and Core Verification

| Command | Exit code | Result |
|---|---:|---|
| First `npx vitest run test/unit/gmail-message-parser.test.ts` | `1` | Expected RED: `message-parser.js` did not exist; 1 suite failed and 0 tests ran |
| First post-implementation `npx vitest run test/unit/gmail-message-parser.test.ts` | `0` | 1 file and 6/6 tests passed |
| First post-implementation `npx tsc --noEmit` | `1` | Exposed a TypeScript address-union narrowing error at `message-parser.ts:117`; implementation was corrected without changing scope |
| Final `npx vitest run test/unit/gmail-message-parser.test.ts` | `0` | 1 file and 6/6 tests passed |
| `npm run typecheck` | `0` | TypeScript passed |
| `npx eslint src\modules\backlinks\adapters\gmail\message-parser.ts test\unit\gmail-message-parser.test.ts` | `0` | Focused ESLint passed |
| `npm run verify:backlinks` | `0` | TypeScript and ESLint passed; source manifest 24 records; dependency allowlist passed; licenses 605 packages; OpenAPI 23 paths; 19 migrations through `0026`; Unit 235/235; API 59/59; Contract 128/128; Integration 124 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |

The full Integration output included the intentional
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` resilience fixture. The enclosing
suite and complete Core command exited `0`.

### Integrity, Unproved Items, and External Effects

- Canonical State, `package.json`, `package-lock.json`, source manifest, and
  third-party notices retained their pre-execution SHA-256 hashes.
- New public API, Migration, integration Event, Webhook, dependency,
  deployment-manifest entry, and shared-change request: none.
- Not proved: live Gmail parsing, production object storage/database behavior,
  a production malformed-message corpus or DSN Gold Set, HTML/XSS safety,
  attachment malware safety, persistence, reply matching, lifecycle mutation,
  or UI behavior. The malformed fixture is local contract evidence only.
- Real network, Gmail, DataForSEO, AI Provider, credentials, and production
  database calls: none. DataForSEO remains present and unchanged.
- The full Integration gate used its disposable local test infrastructure; no
  matching PostgreSQL, Temporal, or Testcontainers container remained after
  the run.
- Git commit, push, merge, rebase, and reset: none.
- BL-AI-133 was not executed.

## Historical BL-AI-130 Handoff

### Preconditions

- V1.4.1 records `BL-AI-124..129` as integrated and `BL-AI-130` as the
  already-started task that must be completed by this execution flow.
- The V1.0 acceptance remains: repair an expired Gmail History ID only inside
  a safe bounded window, never perform unlimited backfill, and append an audit
  event.
- Existing BL-AI-130 implementation and tests were inspected in place. They
  were not overwritten or restarted.

### Exact BL-AI-130 Files

- `src/modules/backlinks/application/policies/mail-history-repair.policy.ts`
- `src/modules/backlinks/application/workflows/mail-history-repair-workflow.ts`
- `src/modules/backlinks/application/services/mail-history-repair.repository.ts`
- `test/unit/gmail-history-repair-policy.test.ts`
- `test/unit/gmail-history-repair-workflow.test.ts`
- `test/backlinks/integration/mail-incremental-sync-repository.test.ts`
- `docs/execution/parallel-blocks/PB-D-MAIL-REPLY-result.md`

This handoff changed only this Result file. The six implementation/test files
above were existing BL-AI-130 work and were audit-read without modification.

### Reviewed Behavior

- Policy fixes one seven-day window, page size 100, maximum ten pages, and
  maximum 1,000 unique provider messages.
- Workflow accepts only the exact expired durable History ID/page-token
  checkpoint, keeps one fixed time anchor across pagination, de-duplicates
  provider message IDs, rejects a changed snapshot, and fails closed on page
  or message bounds before repository commit.
- Repository rechecks the tenant Gmail connection and read capability, locks
  the cursor, rejects stale workers, and atomically inserts unique raw-message
  references, replaces the cursor, and appends
  `gmail.history.repair.completed` to the existing audit chain.
- Raw MIME remains opaque behind the existing object-reference boundary. No
  MIME parsing, HTML rendering, reply matching, API, webhook, or automatic
  scheduling was added.

### Failure-First and Final Verification

| Command | Exit code | Result |
|---|---:|---|
| Historical failure-first `npx vitest run test/unit/gmail-history-repair-policy.test.ts test/unit/gmail-history-repair-workflow.test.ts` | `1` | Expected RED recorded by the existing execution flow because the Policy, Workflow, and Repository modules did not yet exist |
| `npx vitest run test/unit/gmail-history-repair-policy.test.ts test/unit/gmail-history-repair-workflow.test.ts test/backlinks/integration/mail-incremental-sync-repository.test.ts` | `0` | 3 files and 11/11 tests passed; includes Policy/Workflow 6/6 and disposable PostgreSQL incremental/repair Repository 5/5 |
| `npm run verify:backlinks` | `0` | TypeScript and ESLint passed; source manifest 23 records; dependency allowlist passed; licenses 604 packages; OpenAPI 23 paths; 19 migrations through `0026`; Unit 226/226; API 59/59; Contract 128/128; Integration 124 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |

The Integration output included the intentional
`BL_AI_041_INJECTED_WORKER_INTERRUPTION` resilience fixture; the enclosing
suite and complete command exited `0`.

### Shared Changes and Unproved Items

- New public API, Migration, integration Event, Webhook, dependency, NOTICE,
  source-manifest entry, deployment-manifest entry, and shared-change request:
  none.
- Not proved: live Gmail History expiration recovery, provider network
  behavior, production database behavior, production object storage, runtime
  scheduling, MIME parsing, HTML sanitization, reply matching, or UI behavior.
- The PostgreSQL evidence is from an isolated disposable test container and is
  not production E2E evidence.
- DataForSEO remains present and unchanged.
- At the time of the BL-AI-130 handoff, BL-AI-131 and BL-AI-132 had not been
  executed.

## Historical PB-D Scope Through BL-AI-130

- Extended the existing Gmail connection only with the minimum read-only mail
  synchronization capability.
- New OAuth attempts request `gmail.readonly`; existing four-scope send-only
  connections remain valid and expose `mailSyncCapability: false`.
- Forward-only Migration `0015` permits only the existing four scopes plus
  the optional minimal read-only addition, and derives the persisted capability
  marker from `granted_scopes`.
- A domain preflight rejects a disconnected connection, missing read-only scope,
  or marker/scope mismatch before a mail-sync operation can execute.
- Forward-only Migration `0016` adds forced-RLS, project-isolated persistence
  for sync cursors, opaque raw-message object references, Gmail threads and
  messages, inbound replies, and reply-match candidates.
- Raw-message references store only provider identifiers, an object key,
  SHA-256, byte size, fetch/retention/purge timestamps, and no MIME, HTML, or
  body-text column. A candidate match defaults to manual confirmation.
- Added a provider-neutral `GmailSyncPort` with strict initial listing,
  incremental history, single raw-message read, and watch contracts.
- Initial listing returns message references and a stable snapshot History ID.
  Incremental history returns either a page or explicit `history_expired`.
- Raw messages remain opaque unpadded base64url MIME plus provider metadata;
  the Port does not parse or expose HTML/body content.
- The deterministic Fake validates all configured and runtime values, records
  only non-sensitive operation inputs, and performs no network operation.
- Added a default-off Gmail Sync Client Adapter shell. When explicitly enabled,
  it requires an injected provider client and maps only the four BL-AI-126
  operations.
- Initial and History pages preserve provider page tokens and History IDs.
  History maps only `messageAdded`, de-duplicates provider message IDs, and
  converts provider HTTP 404 to explicit `history_expired`.
- Raw message and watch millisecond timestamps map to ISO time; raw base64url
  padding is removed without parsing MIME.
- Added the Initial Sync Workflow with a durable seven-day upper-bounded
  window anchored to the first persisted start time and a fixed page size of
  100.
- The Workflow resumes from the committed provider page token, rejects a
  changed snapshot History ID, de-duplicates provider message IDs per page,
  and drops messages before the window or after the persisted start time.
- Raw MIME remains opaque. It is decoded only for deterministic SHA-256 and an
  idempotent object-store write; PostgreSQL stores only the existing opaque
  object reference and retention metadata.
- The Initial Sync Repository serializes each project/connection lane, inserts
  de-duplicated provider references and advances the cursor in one tenant
  transaction. It rechecks connection availability before new or resumed
  execution. A failed page rolls back both message references and cursor
  advancement.
- Added an Incremental History Sync Workflow with a fixed page size of 100.
  It resumes from the committed History ID and page token, fetches only
  `messageAdded` references exposed by the existing Port, and retains opaque
  raw MIME through the same deterministic object-reference boundary.
- During pagination, the Workflow keeps the original History ID and advances
  only the committed page token. The final page advances to the provider's
  latest History ID only after all page message references are persisted.
- The Incremental Sync Repository inserts de-duplicated message references and
  advances the page token or final History ID in one tenant transaction.
  Failed writes roll back all message references and preserve the prior cursor;
  stale workers resume from the durable checkpoint.
- `history_expired` is returned without cursor mutation by the incremental
  Workflow and may be handed to the separate BL-AI-130 repair Workflow.
- Added a fixed repair policy: seven-day lookback, page size 100, at most ten
  pages, and at most 1,000 unique provider messages. The window is anchored to
  the repair start time and cannot expand during pagination.
- The repair Workflow refuses a non-expired or stale checkpoint, performs one
  bounded initial-list scan, de-duplicates provider message IDs across pages,
  keeps raw MIME opaque, and rejects changed snapshot History IDs.
- The repair Repository rechecks the active tenant connection and
  `mail_sync_capability`, locks the cursor, and atomically inserts unique raw
  message references, replaces the expired cursor with the repaired History ID,
  and appends `gmail.history.repair.completed` to the existing audit chain.
- A stale worker writes neither message references, cursor changes, nor audit
  events. A page/message limit breach fails closed without advancing the
  durable cursor.
- No built-in network client, Google SDK, Token resolution, API, MIME parser,
  HTML sanitizer or renderer, matching algorithm, webhook, real Gmail request,
  production database operation, credential, Git commit, or Git push was
  introduced.

## Historical Changed Files Through BL-AI-130

- `src/modules/backlinks/domain/sending/oauth-attempt.ts`
- `src/modules/backlinks/domain/replies/gmail-mail-sync-capability.ts`
- `src/modules/backlinks/application/gmail-connection.gateway.ts`
- `src/modules/backlinks/api/gmail-connection.schema.ts`
- `src/modules/backlinks/db/schema/gmail-connections.ts`
- `src/modules/backlinks/db/repositories/gmail-connection.repository.ts`
- `src/modules/backlinks/db/migrations/0015_backlink_gmail_sync_capabilities.sql`
- Gmail connection API, contract, resilience, repository, migration, and
  capability tests.
- `src/modules/backlinks/db/migrations/0016_backlink_mail_sync.sql`
- `src/modules/backlinks/db/schema/mail-sync.ts`
- `test/backlinks/integration/mail-sync-migration.test.ts`
- `src/modules/backlinks/ports/gmail-sync.port.ts`
- `src/modules/backlinks/adapters/gmail/sync-fake.adapter.ts`
- `test/contract/gmail-sync-port.test.ts`
- `src/modules/backlinks/adapters/gmail/sync-client.ts`
- `test/contract/gmail-sync-client.test.ts`
- `src/modules/backlinks/application/services/mail-initial-sync.repository.ts`
- `src/modules/backlinks/application/workflows/mail-initial-sync-workflow.ts`
- `test/unit/gmail-initial-sync-workflow.test.ts`
- `test/backlinks/integration/mail-initial-sync-repository.test.ts`
- `src/modules/backlinks/application/services/mail-incremental-sync.repository.ts`
- `src/modules/backlinks/application/workflows/mail-incremental-sync-workflow.ts`
- `test/unit/gmail-incremental-sync-workflow.test.ts`
- `test/backlinks/integration/mail-incremental-sync-repository.test.ts`
- `src/modules/backlinks/application/policies/mail-history-repair.policy.ts`
- `src/modules/backlinks/application/services/mail-history-repair.repository.ts`
- `src/modules/backlinks/application/workflows/mail-history-repair-workflow.ts`
- `test/unit/gmail-history-repair-policy.test.ts`
- `test/unit/gmail-history-repair-workflow.test.ts`

## Historical Verification Through BL-AI-130

| Command | Exit code | Result |
|---|---:|---|
| focused capability unit and PostgreSQL migration tests | `0` | 5/5 passed |
| focused Gmail API/auth/repository/migration/contract/resilience tests | `0` | 28/28 passed |
| `npx vitest run test/backlinks/integration/mail-sync-migration.test.ts` | `0` | 3/3 passed; applies `0016` directly in a disposable PostgreSQL container and verifies cursor, retention, dedupe, relationship, and RLS behavior |
| `npm run typecheck` | `0` | TypeScript passed |
| `npm run lint -- --fix-dry-run ...mail-sync.ts ...mail-sync-migration.test.ts` | `0` | focused ESLint passed |
| `npm run verify:backlinks` | `0` | Unit 195/195; API 59/59; Contract 96/96; Integration 119 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| `powershell -ExecutionPolicy Bypass -File backend/database/tests/verify-postgresql18.ps1` | `0` | PostgreSQL 18.4 clean install, historical upgrade/read, and backup/restore gates passed; the deployment manifest remains unchanged and is separate from the direct `0016` migration test |
| first `npx vitest run test/contract/gmail-sync-port.test.ts` | `1` | expected RED: the BL-AI-126 Port and Fake modules did not exist |
| `npx vitest run test/contract/gmail-sync-port.test.ts` | `0` | 6/6 passed |
| combined Gmail Send/Sync contract suite | `0` | 27/27 passed |
| `npm run typecheck` and focused `eslint --fix-dry-run` | `0` | BL-AI-126 TypeScript and ESLint passed |
| `npm run test:backlinks:contract` | `0` | 120/120 passed |
| API / Integration / Security / Resilience suites | `0` | API 59/59; Integration 116 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| current aggregate `npm run verify:backlinks` | `1` | stopped at a pre-existing stale OpenSEO third-party notice; independent Unit execution passed 208/210 and exposed the same notice mismatch plus an unrelated Assessment source-release ordering assertion. Both files are outside the PB-D allowed path and were not modified |
| first `npx vitest run test/contract/gmail-sync-client.test.ts` | `1` | expected RED: `sync-client.ts` did not exist |
| `npx vitest run test/contract/gmail-sync-client.test.ts` | `0` | 8/8 passed |
| BL-AI-126/127 joint contract suite | `0` | 14/14 passed |
| `npm run typecheck` and focused `eslint --fix-dry-run` | `0` | BL-AI-127 TypeScript and ESLint passed |
| `npm run test:backlinks:contract` after BL-AI-127 | `0` | 128/128 passed |
| API / Integration / Security / Resilience after BL-AI-127 | `0` | API 59/59; Integration 116 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| current aggregate `npm run verify:backlinks` after BL-AI-127 | `1` | still stops at the existing stale OpenSEO notice; Unit independently remains 208/210 for the same notice assertion and unrelated Assessment ordering assertion. BL-AI-127 files pass all focused and shared Contract gates |
| first BL-AI-128 focused Unit and PostgreSQL executions | `1` | expected RED: the Initial Sync Workflow and Repository modules did not exist |
| `npx vitest run test/unit/gmail-initial-sync-workflow.test.ts` | `0` | 6/6 passed; verifies fixed window, upper bound, resume token, completed replay, preflight failure before provider listing, snapshot rejection, and stable Workflow ID |
| `npx vitest run test/backlinks/integration/mail-initial-sync-repository.test.ts` | `0` | 3/3 passed in disposable PostgreSQL; verifies transactional page advancement, provider-message dedupe, stale replay, completion, durable start time, rollback, and capability recheck before resume |
| `npm run typecheck` and focused ESLint after BL-AI-128 | `0` | TypeScript and all four BL-AI-128 source/test files passed |
| API / Contract / Integration / Security / Resilience after BL-AI-128 | `0` | API 59/59; Contract 128/128; Integration 119 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| current aggregate `npm run verify:backlinks` after BL-AI-128 | `0` | TypeScript, ESLint, source manifest 23 records, dependency allowlist, licenses 604 packages, OpenAPI 23 paths, migration check, Unit 216/216, API 59/59, Contract 128/128, Integration 119 passed with 13 environment-gated skips, Security 95/95, and Resilience 3/3 |
| first BL-AI-129 focused Unit and PostgreSQL executions | `1` | expected RED: the Incremental History Sync Workflow and Repository modules did not exist |
| `npx vitest run test/unit/gmail-incremental-sync-workflow.test.ts` | `0` | 4/4 passed; verifies original History ID retention across pages, final cursor advancement, explicit expired-history handoff, raw-object failure behavior, and stable Workflow ID |
| `npx vitest run test/backlinks/integration/mail-incremental-sync-repository.test.ts` | `0` | 3/3 passed in disposable PostgreSQL; verifies message-before-cursor transactional ordering, page-token resume, final History ID commit, rollback to the original cursor, and capability recheck |
| combined Gmail Initial/Incremental/Port/Adapter regression | `0` | 30/30 passed |
| current aggregate `npm run verify:backlinks` after BL-AI-129 | `0` | TypeScript, ESLint, source manifest 23 records, dependency allowlist, licenses 604 packages, OpenAPI 23 paths, migration check, Unit 220/220, API 59/59, Contract 128/128, Integration 122 passed with 13 environment-gated skips, Security 95/95, and Resilience 3/3 |
| first BL-AI-130 focused Unit execution | `1` | expected RED: the bounded repair policy, Workflow, and Repository modules did not exist |
| BL-AI-130 policy and Workflow Unit tests | `0` | 6/6 passed; verifies fixed seven-day bounds, ten-page/1,000-message limits, cross-page de-duplication, stale checkpoint handling, snapshot consistency, atomic handoff, and stable Workflow ID |
| `npx vitest run test/backlinks/integration/mail-incremental-sync-repository.test.ts` after BL-AI-130 | `0` | 5/5 passed in disposable PostgreSQL; includes atomic repaired cursor/message/audit commit and stale-worker no-write behavior |
| current aggregate `npm run verify:backlinks` after BL-AI-130 | `0` | TypeScript, ESLint, source manifest 23 records, dependency allowlist, licenses 604 packages, OpenAPI 23 paths, migration check through 0026, Unit 226/226, API 59/59, Contract 128/128, Integration 124 passed with 13 environment-gated skips, Security 95/95, and Resilience 3/3 |
| published Migration `0014` SHA-256 check | `0` | unchanged at `e95a3de354bbffdf902b59827378b7fd6cbae00aec0fc8f5331a2f5b5af0f0b5` |

## Historical External Effects Through BL-AI-130

- Real network: none.
- Test infrastructure: disposable local PostgreSQL Docker containers were
  started by Integration tests and stopped by their harness; final matching
  container count was zero.
- Credentials: none supplied or persisted.
- Persistent or production database: none.
- Gmail OAuth, Gmail read, and Gmail send: none.
- DataForSEO and AI Provider calls: none.
- Git commit/push: none.

## Historical Remaining Boundary Before BL-AI-133 Dependency Resolution

- `BL-AI-132` remains `HANDOFF_READY`.
- `BL-AI-133` is `BLOCKED` pending the protected shared dependency integration
  described above. Its failure-first fixture and Unit test are preserved.
- `BL-AI-134`, `BL-AI-135`, and `BL-AI-136` remain unexecuted because their
  serial predecessor has not passed.
- This handoff does not authorize HTML rendering/sanitization, attachment
  execution, reply matching, persistence, API exposure, webhook processing,
  automatic scheduling, or live Gmail activation.
