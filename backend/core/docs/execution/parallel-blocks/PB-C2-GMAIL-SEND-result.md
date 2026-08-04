# PB-C2-GMAIL-SEND Result

Status: BL-AI-107..120-INTEGRATED
Baseline date: 2026-07-28
Integrated PB-C2 tasks: BL-AI-107..111; BL-AI-113..120
Integrated shared dependency: BL-AI-112
Remaining tasks: none in PB-C2

## Scope

- Retained the BL-AI-107 Send Intent, Send Attempt, Quota Reservation, and
  Suppression persistence foundation.
- Integrated the BL-AI-108 email normalization, versioned HMAC targets, and
  tenant-scoped Suppression Repository.
- Integrated the BL-AI-109 concurrent Gmail rolling-day quota reservation,
  consumption, and confirmed-not-sent release behavior.
- Restored the published BL-AI-107 Migration 0014 byte-for-byte and moved the
  BL-AI-109 connection-wide quota-read policy into new forward Migration 0023.
- Reviewed and integrated the concurrent BL-AI-110 progressive-verification
  domain state machine and its tests.
- Implemented and integrated BL-AI-111 as an Application Policy Gate that
  blocks unapproved, suppressed, disconnected, over-quota, Kill Switch, and
  cooldown cases before the guarded operation can run.
- Integrated BL-AI-112's exact Nodemailer MailComposer dependency and source,
  license, NOTICE, lockfile, SBOM, and supply-chain evidence.
- Implemented and integrated BL-AI-113 as a fail-closed RFC 5322/MIME builder
  for one authorized sender, one recipient, one subject, and one plain-text
  body.
- Implemented and integrated BL-AI-114 as the approved Send Intent API. It
  rechecks the exact approved Draft version and active Workspace Gmail binding,
  then starts the tenant transaction for a READY Intent.
- Implemented and integrated BL-AI-115 by extending that transaction to reserve
  the connection-scoped quota lane and create the Outbox event atomically, with
  exact idempotent replay of the original Intent.
- Implemented and integrated BL-AI-116 as the provider-neutral Gmail Send Port
  and deterministic Fake Send Adapter contract.
- Implemented and integrated BL-AI-117 as the default-off Gmail Send Client
  Adapter shell with an injected provider-client boundary and stable response
  classification.
- Implemented and integrated BL-AI-118 as an ID-only Send Workflow plus
  Activity/Repository boundary with durable attempt claiming, bounded retries,
  stable RFC Message IDs, and provider Message ID persistence.
- Implemented and integrated BL-AI-119 as an unknown-send-result
  reconciliation workflow. It performs a read-only RFC Message-ID lookup,
  requires manual confirmation for missing or inconclusive provider evidence,
  records an immutable reconciliation fact, and converges only the Send Intent
  to a final state without retrying, changing the unknown Attempt, or releasing
  consumed quota.
- Implemented and integrated BL-AI-120 as append-only delivery-feedback facts,
  immediate hard-bounce/complaint/unsubscribe suppression, 30-day soft-bounce
  thresholding, and protected unsubscribe release authorization.
- Added forward Migration 0026, the deployment manifest entry, PostgreSQL 18
  runner coverage, PB-C2 result, and canonical Coding State through BL-AI-120.
- Did not execute BL-AI-121 or any later task.

## BL-AI-108 Policy

- Suppression email syntax and case normalization reuse the verified
  SendIdentity rule: trim outer whitespace and lowercase the ASCII mailbox.
- Provider-specific alias equivalence is intentionally not inferred.
- Targets use domain-separated HMAC-SHA-256 with a positive key version and a
  minimum 32-byte secret. Plaintext email is not persisted.
- Current and legacy key candidates can be generated together for rotation
  lookups.

## BL-AI-109 Quota Policy

- The default declared GmailConnection limit is 50 sends per rolling 24 hours;
  the Repository accepts the effective limit explicitly so a later policy gate
  can apply a tighter value.
- Quota is shared by all projects and workspaces using the same
  Organization/GmailConnection pair.
- A transaction-level advisory lock serializes reserve and terminal settlement
  operations for that pair.
- The rolling window counts `CONSUMED` rows whose `consumed_at` is newer than
  24 hours and active `RESERVED` rows whose `expires_at` is still in the
  future.
- `PROVIDER_ACCEPTED` and `DELIVERY_UNKNOWN` both transition the reservation to
  `CONSUMED`; an unknown result is never released for retry capacity.
- Only a caller using `releaseConfirmedNotSent` can transition a reservation to
  `RELEASED`, and a nonblank evidence reason is required.
- Released rows stop consuming capacity. Consumed rows leave the window only
  after their individual 24-hour boundary.

## BL-AI-110 Progressive Verification

- A connection starts at `NEW_CONNECTION`, or at `RESTRICTED` when the first
  observation already contains severe reputation or anomaly evidence.
- `NEW_CONNECTION` applies 5 sends per rolling 24 hours with a 300-second
  minimum interval. `REPUTATION_BUILDING` applies 20 and 120 seconds.
  `STANDARD` applies the V1A ceiling of 50 and 60 seconds.
- Low reputation or elevated anomaly rate automatically lowers the effective
  level. Severe risk moves any level to `RESTRICTED`, which applies 1 send per
  rolling 24 hours and a 900-second minimum interval.
- Advancement accepts only the current branded domain state and observed
  evidence; no target-level parameter exists. Each evaluation advances at most
  one level.
- A restricted connection must complete a seven-day cooldown and provide
  healthy evidence before recovering, and recovery returns only to
  `NEW_CONNECTION`.
- Bulk and automated sending remain disabled at every BL-AI-110 level.

## BL-AI-111 Policy Gate

- The policy evaluates the exact requested Draft version and requires the Draft
  to be approved with a matching `approvedVersionId`.
- Recipient Suppression, unavailable Gmail connection state, exhausted or
  expired quota, any active Kill Switch scope, and any future cooldown block
  the operation.
- A reserved quota lane that is not yet eligible is treated as cooldown rather
  than available capacity.
- Decisions expose a stable policy version, ordered block codes, active Kill
  Switch scopes, and the latest known retry time.
- `runAfterGmailSendPolicyGate` evaluates the policy before invoking its
  operation callback and throws `GMAIL_SEND_POLICY_BLOCKED` on any blocker.
- BL-AI-111 does not implement the later GmailSendPort, real adapter, MIME
  builder, Send Intent API, or dispatch Workflow.

## BL-AI-113 MIME Builder

- The builder accepts only an already-authorized `AuthorizedSendIdentity`, one
  recipient, a subject, and a plain-text body.
- Sender, Reply-To, and recipient addresses reuse the strict domain email
  normalizer. Display names and subject reject control characters; subject is
  nonblank and limited to 255 Unicode code points.
- The body rejects NUL and is normalized before serialization. The output uses
  RFC 5322 CRLF line endings and returns both raw bytes and Gmail API-ready
  base64url.
- MailComposer is loaded only from
  `nodemailer/lib/mail-composer/index.js`, with file and URL access disabled.
- Custom headers, HTML, attachments, transport creation, SMTP, `sendMail`,
  network calls, retries, and provider delivery are not exposed.

## BL-AI-114 Approved Send Intent API

- `POST /api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId/send-intents`
  requires an `idempotency-key` header and accepts the approved Draft Version,
  Gmail Connection, message purpose, and follow-up index.
- The server derives the logical message key and requested-send timestamp; the
  client cannot provide either authoritative value.
- The tenant transaction locks the Draft, requires its current and approved
  version IDs to equal the requested version, and verifies an active Workspace
  binding to the selected Gmail Connection.
- The transaction writes a version-1 `READY` Send Intent and
  `backlinks.send-intent.created.v1` Outbox event atomically. An Outbox failure
  rolls the Intent back.
- Duplicate idempotency or logical-message keys return conflict in BL-AI-114.
  Replay and quota-reservation atomicity remain BL-AI-115 responsibilities.
- The command and repository do not call Gmail, Google APIs, transports,
  `GmailSendPort`, or quota reservation.

## BL-AI-115 Atomic Send Intent Transaction

- The command allocates Send Intent, Quota Reservation, and Outbox IDs and
  applies the fail-closed `NEW_CONNECTION` profile: five sends per rolling
  24 hours, a 300-second minimum interval, and a 600-second reservation TTL.
- The tenant transaction sets the Gmail Connection context, takes an
  Organization/GmailConnection advisory lock, and checks for an exact existing
  request before revalidating mutable Draft and connection state.
- A new request writes the READY Send Intent, RESERVED Quota Reservation, and
  `backlinks.send-intent.created.v1` Outbox event in that order. Any database
  failure rolls the complete transaction back.
- Quota usage counts consumed rows within the rolling 24-hour window and
  unexpired reservations. Exhaustion returns a retry time before any write;
  accepted requests sequence `eligibleAt` on the connection lane.
- Replay requires the same Draft, Draft Version, Gmail Connection, purpose,
  follow-up index, and logical message key. It also requires the original
  Reservation and Outbox rows to exist, then returns the original Intent ID
  and requested time without adding rows.
- This task does not implement `GmailSendPort`, provider dispatch, retries,
  workflow execution, or any real Gmail call.

## BL-AI-116 Gmail Send Port and Fake Adapter

- `GmailSendPort` accepts only the Gmail Connection identifier, base64url raw
  MIME, optional Gmail Thread ID, stable RFC Message-ID, and request ID. It
  exposes no Token, Google SDK DTO, transport, draft, recipient, or body field.
- Results use the fixed three-way boundary: `accepted`,
  `definitely_not_sent`, or `acceptance_unknown`.
- An explicit 429 is `definitely_not_sent`, retryable, and may carry
  `retryAfterSeconds`. A 5xx, post-request timeout, or otherwise ambiguous
  result is `acceptance_unknown` and carries no automatic-retry flag.
- The deterministic Fake validates every command and result, counts calls
  without retaining raw MIME, and performs no network or provider operation.
- Bounce remains a post-acceptance delivery fact. The Fake can emit an
  independent hard/soft bounce fact for contract testing, but `bounce` is not
  a valid Gmail Send result kind and does not rewrite provider acceptance.
- BL-AI-116 does not implement the real Gmail Adapter, Token resolution,
  Workflow dispatch, reconciliation, suppression, or any production send.

## BL-AI-117 Gmail Send Client Adapter Shell

- `GmailSendClientAdapter` implements `GmailSendPort` but is disabled by
  default. Explicit enablement requires an injected `GmailSendProviderClient`;
  the adapter contains no built-in network client or Google SDK.
- The provider boundary receives only the Gmail Connection ID, `userId: "me"`,
  raw base64url MIME, and optional Gmail Thread ID. Request ID, RFC Message-ID,
  recipient, subject, body, Tokens, and provider SDK DTOs do not cross it.
- Successful provider responses require a nonblank provider Message ID.
  Malformed success responses remain `acceptance_unknown`.
- HTTP 400 maps to permanent invalid request, final 401 maps to
  reauthorization required, and permanent 403 scope/domain rejection maps to
  forbidden. These results are definitely not sent and nonretryable.
- Explicit 429 or classified 403 quota/rate-limit responses are definitely not
  sent and retryable, with an optional bounded `retryAfterSeconds`.
- Provider 5xx, post-dispatch timeout, post-dispatch transport failure, and
  unclassified failures remain acceptance-unknown. Only a typed failure proven
  to occur before request dispatch is classified retryable.
- The shell does not resolve Tokens, refresh authorization, instantiate a real
  Gmail client, retry requests, dispatch a Workflow, or send network traffic.

## BL-AI-118 Idempotent Send Workflow

- The Workflow input contains only `sendIntentId`; the stable Workflow ID is
  `send-intent/{sendIntentId}`. Tenant, connection, Draft, MIME, recipient, and
  provider context are resolved inside trusted Activities.
- Claiming an attempt locks the Intent/Reservation lane and commits a
  `DISPATCHING` Send Attempt before the provider boundary is invoked. Replaying
  an accepted Intent returns the stored provider Message ID without creating or
  dispatching another attempt.
- Each Intent uses a deterministic RFC Message-ID derived from its ID. The MIME
  builder requires that ID, and an accepted Gmail provider Message ID and
  optional Thread ID are persisted atomically with terminal settlement.
- Automatic retry is allowed only for a proven `definitely_not_sent` result
  marked retryable. The Workflow is limited to three attempts and caps provider
  retry delays at 300 seconds.
- `acceptance_unknown` and an existing `DISPATCHING` attempt require
  reconciliation and are never blindly resent. A persisted retryable result
  cannot be reclaimed before its `retry_eligible_at` timestamp.
- Forward Migration 0024 permits exactly one `DISPATCHING`-to-terminal
  settlement while retaining terminal immutability. Accepted and unknown
  results consume quota, final failures release it, and retryable failures keep
  the reservation for the bounded retry.

## BL-AI-119 Unknown Send Result Reconciliation

- The Workflow input contains only `sendIntentId`; the stable Workflow ID is
  `send-reconciliation/{sendIntentId}`. Tenant, Gmail Connection, and RFC
  Message-ID are resolved only by trusted Activities.
- Automated reconciliation queries an injected read-only sent-message boundary
  by RFC Message-ID. A provider-found result records `PROVIDER_ACCEPTED`.
  Missing or inconclusive provider evidence never triggers another send and
  returns `manual_confirmation_required`.
- A human confirmation may record either provider acceptance or
  `CONFIRMED_NOT_SENT`. The reconciliation fact is append-only and unique for
  each Send Attempt. Replays return the recorded fact; a conflicting decision
  is rejected.
- Reconciliation does not update the `DELIVERY_UNKNOWN` Send Attempt or its
  `CONSUMED` quota Reservation. It only converges the Send Intent to
  `PROVIDER_ACCEPTED` or `FAILED_FINAL`.

## BL-AI-120 Delivery Feedback Suppression

- Delivery feedback accepts an opaque provider event ID and an existing
  HMAC-only email target. Plaintext email is not stored in the feedback fact or
  suppression entry.
- `HARD_BOUNCE`, `COMPLAINT`, and `UNSUBSCRIBE` create organization-scoped
  active suppression immediately. A `SOFT_BOUNCE` is recorded first and creates
  `SOFT_BOUNCE_THRESHOLD` only at three events for the same HMAC target within
  the preceding 30 days.
- Feedback facts are append-only, tenant-scoped, and unique by organization
  plus provider event ID. Replaying the same source event returns the original
  fact and does not create another suppression.
- An ordinary user cannot release an `UNSUBSCRIBE` suppression. Only the
  `COMPLIANCE_ADMINISTRATOR` role can submit that release; the repository locks
  the stored entry and rechecks its actual reason before changing state.
- Forward Migration 0026 expands the existing suppression reason constraint
  without rewriting published Migration 0014 and adds the append-only feedback
  table, partial soft-bounce lookup index, forced RLS, and writer grants that
  omit update and delete.

## Concurrent Frontend Synchronization (BL-AI-101..120)

The following frontend handoff evidence is preserved but is not part of the
BL-AI-108/109 integration decision:

- The Email Center reads the public Gmail status endpoint and submits connect
  and versioned disconnect commands through the existing Gateway base.
- The frontend DTO contains connection metadata only. It defines no access
  token, refresh token, authorization code, or local authoritative connection
  state.
- Project changes fail closed while the new project's connection status loads;
  a previously loaded Gmail identity is not reused across project routes.
- The UI displays the verified primary identity, connection/reauthorization/
  paused states, granted scope count, token-free boundary, Suppression HMAC
  policy, rolling quota reservation, and progressive-verification rules.
- Because no BL-AI-110 public read projection exists yet, the UI labels its
  verification level as a conservative projection and never uses it to relax a
  server policy.
- The former `Gmail Mock 已连接` and `Mock 发送成功` behaviors were removed.
  Draft actions still open a read-only send-review sheet. BL-AI-115 now adds
  server-side atomic reservation and replay to the public Send Intent API, but
  this task did not wire frontend submission. Suppression, current quota usage,
  Kill Switch, follow-up rules, and send success remain unknown in that sheet.
- The user-authorized frontend projection now covers BL-AI-101..120. The Email
  Center exposes the delivery-feedback suppression policy and keeps the
  review sheet read-only: hard bounce, complaint, and unsubscribe suppression;
  the 30-day/three-event soft-bounce threshold; `DELIVERY_UNKNOWN`; and the
  ordinary-user unsubscribe-release restriction.
- It does not introduce a feedback-result API, a suppression-result read API,
  frontend Send Intent submission, formal BL-AI-121 connection-status work, or
  BL-AI-122 approved-send UI.

## Isolation

- Reservation `INSERT` and `UPDATE` policies remain exact
  Organization/Workspace/Website Project checks.
- The `SELECT` policy permits connection-wide quota reads only when the current
  workspace has an active binding to the selected GmailConnection.
- This permits a serialized cross-project count without permitting one project
  to mutate another project's reservation.
- The Repository verifies the active workspace binding and matching Send Intent
  before inserting.

## Principal Files

- `src/modules/backlinks/application/services/send-quota.repository.ts`
- `src/modules/backlinks/application/services/send-policy-gate.ts`
- `src/modules/backlinks/db/migrations/0014_backlink_send_intents.sql`
- `src/modules/backlinks/db/migrations/0023_backlink_send_quota_connection_scope.sql`
- `src/modules/backlinks/db/migrations/0024_backlink_send_attempt_settlement.sql`
- `src/modules/backlinks/domain/sending/suppression.ts`
- `src/modules/backlinks/domain/sending/progressive-verification.ts`
- `src/modules/backlinks/application/services/send-suppression.repository.ts`
- `src/modules/backlinks/application/services/delivery-feedback.repository.ts`
- `src/modules/backlinks/application/commands/delivery-feedback.command.ts`
- `src/modules/backlinks/domain/sending/delivery-feedback.ts`
- `src/modules/backlinks/application/services/send-attempt.repository.ts`
- `src/modules/backlinks/application/workflows/send-workflow.ts`
- `src/modules/backlinks/application/activities/send-activity.ts`
- `src/modules/backlinks/adapters/gmail/message-builder.ts`
- `src/modules/backlinks/ports/gmail-send.port.ts`
- `src/modules/backlinks/adapters/gmail/send-fake.adapter.ts`
- `src/modules/backlinks/adapters/gmail/send-client.ts`
- `src/modules/backlinks/application/services/send-intent.repository.ts`
- `src/modules/backlinks/application/commands/send-intent.command.ts`
- `src/modules/backlinks/api/send-intent.schema.ts`
- `src/modules/backlinks/api/send-intent.route.ts`
- `test/unit/gmail-send-policy-gate.test.ts`
- `test/unit/gmail-progressive-verification.test.ts`
- `test/unit/gmail-message-builder.test.ts`
- `test/unit/gmail-send-workflow.test.ts`
- `test/unit/gmail-send-activity.test.ts`
- `test/contract/gmail-send-port.test.ts`
- `test/contract/gmail-send-client.test.ts`
- `test/unit/gmail-send-intent-command.test.ts`
- `test/unit/gmail-send-intent-repository.test.ts`
- `test/backlinks/api/send-intent-route.test.ts`
- `test/unit/suppression.test.ts`
- `test/backlinks/integration/send-suppression-repository.test.ts`
- `test/unit/gmail-delivery-feedback.test.ts`
- `test/backlinks/integration/delivery-feedback-repository.test.ts`
- `test/backlinks/integration/send-quota-repository.test.ts`
- `../api/app/api/routes/backlinks.py`
- `../api/app/core/backlinks_gateway.py`
- `../contracts/openapi/backlinks.v1.json`
- `../contracts/openapi/platform.v1.json`
- `../../../database/deployment-manifest.v1.json`
- `../../../database/tests/verify-postgresql18.ps1`

## Verification

| Check                                                        | Result                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Joint BL-AI-108/109 focused suite                            | PASS, 15/15                                                                     |
| Focused BL-AI-108 Unit and PostgreSQL                        | PASS, 6/6                                                                       |
| Focused BL-AI-109 PostgreSQL                                 | PASS, 4/4                                                                       |
| Focused BL-AI-110 Unit                                       | PASS, 5/5                                                                       |
| Focused BL-AI-111 Unit                                       | PASS, 6/6                                                                       |
| Focused BL-AI-112 dependency/manifest/NOTICE suite           | PASS, 15/15                                                                      |
| Focused BL-AI-113 MIME builder                               | PASS, 6/6                                                                        |
| Focused BL-AI-114 command, repository, and API route         | PASS, 13/13                                                                      |
| BL-AI-114 private server and route registration              | PASS, 6/6                                                                        |
| Focused BL-AI-115 command, repository, and API route         | PASS, 19/19                                                                      |
| BL-AI-109/115 PostgreSQL quota and atomic transaction suite  | PASS, 7/7                                                                        |
| Focused BL-AI-116 Gmail Send Port contract                   | PASS, 7/7                                                                        |
| Joint BL-AI-113/116 MIME and Send contract                   | PASS, 13/13                                                                      |
| Focused BL-AI-116/117 Send Port and Client contract          | PASS, 21/21                                                                      |
| Joint BL-AI-113/116/117 MIME and Send contract               | PASS, 27/27                                                                      |
| Focused BL-AI-118 Workflow, Activity, MIME, and PostgreSQL    | PASS, 24/24                                                                      |
| Focused BL-AI-119 Workflow, Activity, and PostgreSQL          | PASS, 14/14 unit and 10/10 PostgreSQL                                            |
| Focused BL-AI-120 policy and command suite                    | PASS, 5/5 Unit                                                                   |
| Focused BL-AI-120 PostgreSQL feedback/release suite           | PASS, 2/2                                                                        |
| BL-AI-101..120 frontend source contract                       | PASS, 2/2                                                                        |
| Public Gateway, shared contracts, and Ruff                   | PASS, retained BL-AI-114 baseline; not rerun for BL-AI-115                       |
| Published 0014 plus forward 0023/0024/0025/0026 upgrades     | PASS, 0014 checksum retained and feedback added in 0026                          |
| Deployment manifest                                          | PASS, 4/4                                                                       |
| TypeScript typecheck and full ESLint                         | PASS                                                                            |
| Source/dependency/license gates                              | PASS, 22 records and 604 packages                                               |
| Backlinks OpenAPI and migration baseline                     | PASS, 23 paths                                                                  |
| Public aggregate OpenAPI                                     | PASS, retained BL-AI-114 baseline: 45 paths and 49 operations                   |
| Full Core Unit                                               | PASS, 192/192                                                                   |
| Full Core API                                                | PASS, 59/59                                                                     |
| Full Core Contract                                           | PASS, 96/96                                                                     |
| Full Core Integration                                        | PASS, 114 passed; 13 environment-gated skipped                                  |
| Full Core Security                                           | PASS, 95/95                                                                     |
| Full Core Resilience                                         | PASS, 3/3                                                                       |
| `npm run verify:backlinks`                                   | PASS, exit 0                                                                    |
| Shared Python migration system                               | PASS, 4/4                                                                       |
| PostgreSQL 18.4 clean/upgrade/historical-read/backup/restore | PASS, exit 0                                                                    |
| Production dependency audit                                  | PASS, retained baseline; not rerun for BL-AI-115                                |
| Backlinks SBOM                                               | PASS, retained baseline; not rerun for BL-AI-115                                |

The focused PostgreSQL suite runs through a non-superuser writer role. It
verifies 20 concurrent cross-project contenders against a limit of five,
strict lane sequencing, confirmed-failure release, unknown-result retention,
the exact rolling 24-hour boundary, and cross-project read-only quota
visibility. It also verifies that 12 concurrent retries retain one Intent, one
Reservation, and one Outbox event; Reservation or Outbox insertion failure
rolls all earlier writes back; and quota exhaustion creates no Intent. The
BL-AI-118 extension verifies accepted Message ID persistence and replay without
a new Attempt, immutable terminal results, persisted retry waiting, and
unknown-result reconciliation without resend.
The BL-AI-119 extension verifies that a provider-found RFC Message-ID records
acceptance, missing evidence stops for manual confirmation, a manually
confirmed-not-sent outcome finalizes only the Intent, and replay does not query
or write again. Its PostgreSQL coverage verifies append-only reconciliation
facts, duplicate-decision replay, conflicting-decision rejection, unknown
Attempt retention, and consumed-quota retention.

## Integration Boundary

- Published Migration 0014 is restored to SHA-256
  `e95a3de354bbffdf902b59827378b7fd6cbae00aec0fc8f5331a2f5b5af0f0b5`.
- New forward Migration 0023 has SHA-256
  `2fdca69c69d2e138e93410a1232bd949642fca3c8ba0e11b0c0e2e4338d94c3c`.
- New forward Migration 0024 has SHA-256
  `4289b0a8de6733bd0699d9df696b69358d9d043673305a194f79e6b3ffe62129`.
- New forward Migration 0025 has SHA-256
  `dcd8c7c93ca0a113f3b3e658888108258affcef5e81d4f6219b686aa5ba1e3c5`.
- New forward Migration 0026 has SHA-256
  `eb3c0e6933215efa2cb301c00687507e0873cddc645aa7ce85dabc28cb6d3da6`.
- The relevant deployment order is now
  `0013 -> 0014 -> 0022 -> 0023 -> 0024 -> 0025 -> 0026`; no published migration or
  recorded checksum was replaced.
- BL-AI-108 through BL-AI-119 are integrated development capabilities, with
  BL-AI-112 owned by PB-SHARED-DEPS. This is not a claim that the complete
  PB-C2 send path or production Gmail delivery is available.

## External Effects

- Real Gmail or Google API call: none.
- Real credential or supplied secret use: none.
- Production or persistent database operation: none.
- Gmail send: none.
- Git commit or push: none.

## Handoff Boundary

- BL-AI-107 through BL-AI-120 are integrated; BL-AI-112 remains owned by the
  shared-dependency block.
- This result claims local MIME construction plus approved Send Intent,
  quota-reservation, Outbox, idempotent-replay persistence, and a
  provider-neutral Send Port/Fake contract plus a default-off real-adapter
  shell, durable idempotent Send Workflow/Activity contract, explicit
  unknown-result reconciliation, and delivery-feedback suppression. It does
  not claim an instantiated Gmail SDK/client, Token resolution, Gmail delivery,
  frontend submission, formal BL-AI-121/122 completion, or product E2E proof.
