# PB-LIVE-ACTIVATION Result

Status: `IN_PROGRESS`
Current serial task: `STOPPED_AFTER_LIVE-004`
GMAIL_LOCAL_PRODUCT_ACCEPTANCE: `PASS`
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`
Branch: `外链part`
HEAD: `8e056945975093c2c720e944fca6666c2638ece3`
Operator: Codex
Recorded verification end: `2026-08-02T23:57:24+08:00`
Prerequisite: `BL-AI-197 = DONE`

## Serial Status

| Task | Status | Evidence |
| --- | --- | --- |
| `LIVE-001` | `PASS` | Production composition, persistent local Canary, two clean three-process starts, readiness/listener checks, two graceful shutdowns, and application restart persistence verification passed |
| `LIVE-002` | `PASS` | Persistent no-Mock Browser -> FastAPI -> private Core -> PostgreSQL/RLS -> Outbox -> Temporal Worker -> PostgreSQL Projection -> FastAPI -> Browser E2E passed, including replay, two-Workspace isolation, cache isolation, and restart persistence |
| `LIVE-003` | `PASS` | Local-product Google OAuth completed through the real frontend and FastAPI callback. Disconnect, token-reference destruction, reconnect, refresh, full-stack restart persistence, PKCE cleanup, zero-send proof, negative tests, and Secret scans passed |
| `LIVE-004` | `PASS` | One controlled Gmail message was sent through the product workflow, the recipient confirmed receipt and replied, polling synchronized and matched the reply, browser UI showed the two-message thread, dedupe/restart/RLS checks passed, and Gmail Send/Sync were closed again |
| `LIVE-005` | `NOT_STARTED` | No DataForSEO call or cost-ledger Canary executed |
| `LIVE-006` | `NOT_STARTED` | No real AI Provider call executed |
| `LIVE-GATE` | `NOT_STARTED` | No separate live gate or Kill Switch drill executed |

## Production Composition

- Added `backend/core/src/modules/backlinks/runtime/production-runtime.ts` as
  the formal `BACKLINKS_RUNTIME_MODULE`.
- `createApiDependencies` composes the real PostgreSQL repositories, API
  commands and queries, signed project-context resolution, and transaction
  local organization/workspace/project RLS context.
- `createWorkerRegistrations` composes the Temporal workflow activities that
  do not require an external provider.
- Runtime ownership closes PostgreSQL pools, Temporal clients, and API
  dependencies.
- Production runtime source has no reference to test fixtures, fakes, mocks,
  or in-memory repositories.
- Gmail send/sync, DataForSEO, AI, Browser, and other unavailable provider
  activities fail closed. All five provider enable flags remain exactly
  `false` in API, Worker, and FastAPI runtime files.
- Migration `0033_backlink_runtime_governance.sql` and deployment manifest
  head `0033` provide the production governance tables, grants, and forced
  RLS policies required by the composition.

## Persistent Local Canary

- Compose project: `growthos-live001`.
- PostgreSQL: `18.4`, bound to `127.0.0.1:55432`, healthy, with named volume
  `growthos-live001-postgres-data`.
- Temporal: Canary namespace `growthos-backlinks-canary`, 24-hour retention,
  SQLite persistence, healthy, with named volume
  `growthos-live001-temporal-data`.
- Secrets are stored under
  `%LOCALAPPDATA%\GrowthOS\live001\secrets` and mounted read-only; no secret
  value is stored in the repository.
- `growthos_backlinks_canary` and `growthos_gateway_canary` are login roles
  with `NOSUPERUSER`, `NOBYPASSRLS`, and role-level `row_security=on`.
- Alembic head is `20260724_0007`; all 27 Backlinks migrations through
  `0034` are applied.
- Seed identity:
  - organization `11111111-1111-4111-8111-111111111111`
  - workspace `22222222-2222-4222-8222-222222222222`
  - website project `33333333-3333-4333-8333-333333333333`
  - project key `live001-canary`
  - actor `live001-canary-operator` / `live001-canary-session`
- The signed Canary access token was written outside the repository and
  accepted by the production `HmacPlatformAuthenticationAuthority`.
- The active project context, project settings/retention, and five blocked
  provider Kill Switch records are present after application restart.

## Verification

Static and automated verification:

- `npm run verify:backlinks` -> exit `0`
  - Unit: 400
  - API: 86
  - Contract: 144
  - Integration: 171 passed, 13 environment-gated skips
  - Security: 102
  - Resilience: 8
  - source manifest: 26 records
  - dependency allowlist and 642-package license check passed
  - OpenAPI: 45 paths
  - migrations: 26 through `0033`
- `npm run build` -> exit `0`
- focused production-runtime tests -> 3/3 passed
- Python `ruff check app tests` -> exit `0`
- Python `pytest -q` -> exit `0`, 35 passed / 1 skipped
- production runtime forbidden-reference scan ->
  `NO_FORBIDDEN_RUNTIME_REFERENCES`

Runtime acceptance:

1. Run `20260731-132832`:
   - Core `/health` and `/ready`: HTTP 200
   - FastAPI `/health` and `/ready`: HTTP 200
   - FastAPI listened on `0.0.0.0:7200`
   - private Core listened only on `127.0.0.1:7301`
   - Temporal workflow/activity pollers registered on
     `growthos.backlinks.v1`
   - shutdown completed with Worker
     `STOPPING -> DRAINING -> DRAINED -> STOPPED`, FastAPI application
     shutdown complete, and zero remaining application listeners
2. Restart run `20260731-133612`:
   - all four readiness endpoints again returned HTTP 200
   - listener bindings and Temporal pollers were re-established
   - PostgreSQL project/context/Kill Switch records and Temporal namespace
     remained present
   - final shutdown was graceful; listeners `0`, application processes `0`,
     and PID state removed

## LIVE-002 Persistent Full-Stack E2E

Formal data creation and runtime boundary:

- Migration `0034_backlink_outbox_temporal_projection.sql` added the durable
  Outbox relay claim/publish contract and monitoring-initialization
  Projection. The deployment manifest and migration checker passed with head
  `0034`.
- `ops/live/Seed-Live002Canary.ps1` ran through the restricted application
  role and formal migrations. It created only controlled non-production
  organization, Workspace, Website Project, Project Context, Prospect,
  Recommendation, Opportunity, Candidate, and initial validation precursor
  facts. It explicitly verified that Placement, monitoring Outbox, and
  Projection final facts did not exist before the API operation.
- Workspace A / Project A:
  `22222222-2222-4222-8222-222222222222` /
  `33333333-3333-4333-8333-333333333333`.
- Workspace B / Project B:
  `22222222-2222-4222-8222-222222222223` /
  `33333333-3333-4333-8333-333333333334`.
- FastAPI connected as `growthos_gateway_canary`; private Core and Worker
  connected as `growthos_backlinks_canary`. Both roles are `NOSUPERUSER`,
  `NOBYPASSRLS`, and `row_security=on`. The Gateway role has no
  `INSERT/UPDATE/DELETE` grant on `backlinks.backlink_placements`; Core owns
  the Backlinks write path.

Business request and trace:

- A real headed Chrome session used FastAPI only. Playwright request routing
  reported `No active routes`; no `route.fulfill`, MSW, proxy response, Mock
  Server, Fake Provider, fixture runtime, in-memory Repository, or local
  Temporal adapter participated.
- Browser command request ID:
  `live002-browser-confirm-20260731-001`; private Core request ID: `req-7`;
  HTTP status: `200`.
- Validation/fact ID:
  `44cc1d9c-0e6f-4789-80e2-46dbd8781374`.
- Placement fact ID:
  `f9aa55f1-f432-42a5-9219-199201d91433`.
- Monitoring Outbox ID:
  `18165d70-18d4-4e5c-a4fe-d945a3d5b03b`.
- Candidate lifecycle ID:
  `8bd6a961-308c-40f5-a6f2-744c5a9449a4`; Placement lifecycle ID:
  `37eb70fe-0688-4ded-953c-7be08a2deb09`; audit ID:
  `632719f7-5529-4cc7-8b61-2dabf22e2779`.
- Temporal Workflow ID:
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:placement-monitoring-initialization:v1:18165d70-18d4-4e5c-a4fe-d945a3d5b03b`.
- Projection ID and source Outbox ID are both
  `18165d70-18d4-4e5c-a4fe-d945a3d5b03b`; the Projection references
  Placement `f9aa55f1-f432-42a5-9219-199201d91433`, policy
  `placement-monitoring-policy.v1`, and has
  `browser_fallback_enabled=false`.

Temporal execution and replay:

- The first durable run
  `019fb6d7-e121-7a54-b1ef-ba45e6299b24` exposed a production ESM workflow
  bundle defect (`ReferenceError: require is not defined`). The five workflow
  definitions were corrected to use the supported static
  `@temporalio/workflow` import, and a regression test was added.
- `temporal workflow reset --type FirstWorkflowTask` preserved the original
  history and produced Run
  `5a1a9b2d-2089-4205-8140-2727cef0747b`, which completed with state
  `created` and persisted the Projection.
- A controlled Outbox delivery-metadata replay changed only delivery state,
  not business facts. Attempt count changed from `1` to `2`; Placement,
  validation, Outbox, and Projection counts remained `1/1/1/1`.
- Replay reused the deterministic Workflow ID. Run
  `019fb6ec-15f9-7a31-90cc-f8d4539ae9ad` completed with state `existing` and
  the same Projection, Outbox, and Placement IDs. No duplicate business fact
  was created.

Tenant and cache isolation:

- Direct PostgreSQL verification as `growthos_backlinks_canary`, tenant B,
  returned unauthorized tenant-A Placement read count `0` and update count
  `0`; the transaction was rolled back.
- The same role under tenant A returned Placement count `1` and Projection
  count `1`.
- Browser access with the tenant-A token to tenant B returned `403
  PLATFORM_PROJECT_ACCESS_DENIED` for both read and write.
- Project B's own browser list returned `200`, metadata for Project B, and
  item count `0`; Project A's list returned `200`, metadata for Project A,
  item count `1`, and the exact Placement ID. Cache state did not cross
  Website Project boundaries.

Processes, listeners, health, and persistence:

- Run `20260731-143014`: Worker group PID `9416`, FastAPI group PID `41724`,
  Core group PID `20624`; effective FastAPI PID `5132`, Core PID `9044`,
  Worker PID `29236`.
- Run `20260731-144831`: Worker group PID `24440`, FastAPI group PID `14540`,
  Core group PID `40232`; effective FastAPI PID `31324`, Core PID `34424`.
- FastAPI listened on `0.0.0.0:7200`; private Core listened only on
  `127.0.0.1:7301`; PostgreSQL listened on `127.0.0.1:55432`; Temporal gRPC
  on `127.0.0.1:57233`; Temporal metrics on `127.0.0.1:59090`.
- Core `/health` and `/ready`, FastAPI `/health` and `/ready`, PostgreSQL
  health, Temporal health, and Worker poller registration passed on both
  runs.
- After the second application start, a real browser refresh and request ID
  `live002-browser-after-restart-001` returned HTTP `200`, private Core
  request `req-6`, the same Placement ID, and `displayState=confirmed`.
- The latest deterministic Workflow remained `COMPLETED` with replay Run
  `019fb6ec-15f9-7a31-90cc-f8d4539ae9ad` and state `existing` after the
  application restart.
- PostgreSQL and Temporal remained separate healthy containers with named
  persistent volumes. FastAPI, Core, Worker, and browser were independently
  stopped after acceptance; application listener count is `0`.

Verification commands and exits:

- `npm run typecheck` -> exit `0`.
- `npm run lint` -> exit `0`.
- `npm run build` -> exit `0`.
- Focused Vitest for workflow definitions, Outbox relay, Worker, and shared
  namespaces -> exit `0`, 4 files / 21 tests.
- Migration manifest/checker and Python manifest tests -> exit `0`.
- Production runtime forbidden-reference scan for
  `test/fixtures|Fake|Mock|InMemory|LocalTemporal` -> no match.
- `Seed-Live002Canary.ps1`, `New-Live002CanarySession.ps1`, two application
  starts, readiness checks, graceful stops, browser E2E, RLS SQL, Outbox
  replay, Temporal describe/list, and persistence checks -> exit `0`.
- One preliminary browser GET returned `401` because an external helper
  serialized a PowerShell `FileInfo` instead of token text. It performed no
  business write; the helper and token were rotated, zeroed, and deleted
  before the successful browser run.

Cleanup and retained evidence:

- Provider fetch leases: `0`; Canary rate-limit reservations: `0`; active
  Canary jobs: `0`; running Temporal workflows: `0`; LIVE-002 browser
  sessions: `0`; repository-external LIVE-002 token/helper files: `0`.
- All five Project-A Provider Kill Switch records remain blocked:
  `AI_PROVIDER`, `backlinks.dataforseo.v1`, `BROWSER_PROVIDER`,
  `GMAIL_SEND`, and `GMAIL_SYNC`.
- API and Worker flags for Gmail send/sync, DataForSEO, AI, and Browser remain
  `false`. No external Browser Provider or shared Crawler fallback was used.
- Controlled Canary business facts, Outbox history, Workflow history,
  Projection, logs, and PostgreSQL/Temporal named volumes are retained as
  persistent acceptance evidence.

## Historical LIVE-003 Google Cloud OAuth Preflight Block

Execution window:

- Started: `2026-07-31T15:08:00+08:00`.
- Stopped: `2026-07-31T15:12:42+08:00`.
- Result: `BLOCKED`.
- Operator: Codex.

Blocking evidence:

- The authorized message left all four required LIVE-003 values as literal
  placeholders:
  - Google Cloud Canary Project: `<填写脱敏标识>`
  - OAuth Client Secret Reference: `<填写引用，不填写 Secret>`
  - HTTPS Redirect URI: `<填写精确地址>`
  - Canary Gmail test user: `<填写脱敏标识>`
- The repository-external LIVE-001 Secret directory contains only database,
  platform signing, and platform access files. It contains no Google OAuth
  client, Gmail token, PKCE, or Google Secret Manager reference.
- The three no-secret runtime environment files contain no Google Cloud
  project, OAuth client, OAuth Secret Reference, or Redirect URI setting.
  Gmail Send and Sync remain `false`.
- The host probe returned `GCLOUD_AVAILABLE=false`,
  `ACTIVE_ACCOUNT=false`, and `ACTIVE_PROJECT=false`.
- Production composition still maps Gmail `connect` and `complete` to the
  fail-closed `providerDisabled("Google OAuth")` path. Existing
  `GoogleAuthClientAdapter` and `SecretStoreClientAdapter` are injected-client
  boundaries, not configured Google network or Secret Store clients.
- The only active public application endpoint previously verified is FastAPI
  on port `7200`; no exact approved HTTPS callback endpoint was supplied.

Commands and exits:

- Required handbook, canonical state, result ledger, and LIVE-001 runbook
  reads -> exit `0`.
- Repository-external Secret filename and no-secret environment inventory ->
  exit `0`; no Secret value was printed.
- OAuth/Google/Secret Store source and runtime-composition scan -> exit `0`.
- Redacted Google Cloud CLI/account/project capability probe -> exit `0` and
  reported no installed CLI, active account, or active project.

Safety outcome:

- No Google Cloud project, Consent Screen, OAuth Client, Redirect URI, test
  user, Secret Store entry, OAuth attempt, authorization URL, callback, Token,
  or Gmail connection was created or used.
- External Google/Gmail calls: `0`; email sends: `0`; Token exchanges: `0`.
- No Client Secret, Token, authorization code, PKCE verifier, API key, or
  account identifier was written to the repository, PostgreSQL, logs, Trace,
  screenshots, or this result file.
- Per the serial stop rule, LIVE-004, LIVE-005, LIVE-006, and LIVE-GATE were
  not started.

Final local state:

- PostgreSQL and Temporal Canary containers remain healthy with persistent
  named volumes.
- FastAPI, Core API, Worker, and the LIVE-002 browser session are stopped.
- No temporary LIVE-002 token/helper file, lease, reservation, active job, or
  running Workflow remains.
- No real Gmail, DataForSEO, AI, or Browser provider was called.
- All Provider enable flags and Project Kill Switches remain closed.

## LIVE-003 Local Product Acceptance Resume

Execution window and boundary:

- Resumed under `LOCAL_PRODUCT_ACCEPTANCE`; this is not a public deployment or
  production-release approval.
- Final verification: `2026-08-01T13:38:20+08:00`.
- Result: `PASS`.
- Public browser base: `http://localhost:5173`.
- Sole browser Gateway: `http://localhost:7200`.
- Private Core: `http://127.0.0.1:7301`.
- OAuth callback:
  `http://localhost:7200/api/v1/projects/live001-canary/backlinks/gmail-connections/callback`.
- The independent Google Cloud Canary project and masked Gmail test user are
  recorded in the repository-external authorization manifest. No customer or
  production Google resource was used.

Production composition and provider controls:

- `BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT_ACCEPTANCE` and
  `BACKLINKS_LIVE_CANARY_STAGE=LIVE-003` were active in Core, Worker, and
  FastAPI.
- Google OAuth and the platform Secret Store were enabled only for LIVE-003.
- Gmail Send, Gmail Sync, DataForSEO, AI, and external Browser Provider flags
  remained `false` in all three runtime environment files.
- The real Google OAuth client performed authorization, code exchange, identity
  verification, token refresh support, revocation, and reconnect through the
  formal production composition. No Fake, Mock, fixture runtime, request
  interception, or in-memory Token Store was in the acceptance graph.
- OAuth state was SHA-256 bound to the local user session and tenant context;
  PKCE used S256, attempts had a maximum ten-minute TTL, consumption was
  one-time, and invalid/expired callback handling failed closed.
- Expired unconsumed PKCE verifier cleanup destroyed eight remaining protected
  Secret values. PostgreSQL now records all twelve PKCE references as
  `DESTROYED` and no PKCE reference as `ACTIVE`.

Connection, disconnect, and persistence evidence:

- Initial real connection:
  `5f5c3719-4617-46b0-a131-3485c9343c69`.
- Formal disconnect changed that connection to `DISCONNECTED`, version `2`,
  removed its Token Secret Reference, completed revocation cleanup, and marked
  the old Token Secret Reference `DESTROYED`.
- Final real reconnect created connection
  `ce7b81a9-9023-4a0b-a1ba-371dca9fc737` from consumed OAuth attempt
  `b060c880-0323-49e2-97bb-e41adab43ee3`.
- FastAPI status after browser refresh and a complete application-stack restart
  returned `CONNECTED`, masked account `t***@gmail.com`,
  `sendAvailability=AVAILABLE`, `mailSyncCapability=true`, version `1`, and the
  exact approved scopes `openid`, `email`, `profile`, `gmail.send`, and
  `gmail.readonly`.
- The final Token Set is represented by one `ACTIVE` Secret Reference. The
  Token value remains only in the protected repository-external Secret Store.
- PostgreSQL verification ran as `growthos_backlinks_canary` with
  `row_security=on`.

Restart and process evidence:

- Previous application run was stopped gracefully at
  `2026-08-01T13:21:16+08:00`.
- Restart run `20260801-132126` started at
  `2026-08-01T13:21:26.4983608+08:00`.
- Process-group PIDs were Core `35636`, Worker `38100`, FastAPI `34836`, and
  Frontend `42928`.
- Actual listeners were Frontend `127.0.0.1:5173` PID `20848`, FastAPI
  `127.0.0.1:7200` PID `25100`, private Core `127.0.0.1:7301` PID `21464`,
  PostgreSQL `127.0.0.1:55432`, and Temporal `127.0.0.1:57233`.
- Core readiness, FastAPI readiness, and Frontend returned HTTP `200`; Worker
  logged `backlinks.worker.ready` for Task Queue `growthos.backlinks.v1`.
- PostgreSQL 18 and Temporal remained healthy with persistent named volumes
  `growthos-live001-postgres-data` and
  `growthos-live001-temporal-data`.

Verification commands and exits:

- Core `npm run verify:backlinks` -> exit `0`: Unit `412`, API `88`, Contract
  `151`, Integration `173` passed with `13` explicit environment skips,
  Security `102`, and Resilience `8`.
- Core `npm run build` -> exit `0`.
- FastAPI Ruff -> exit `0`; full pytest -> exit `0`, `55 passed`, `1 skipped`.
- Frontend typecheck, lint, and build -> exit `0`; twelve Node source suites
  passed `40` tests.
- PostgreSQL acceptance query -> exit `0`: Gmail Send Intents `0`, Send
  Attempts `0`, rate-limit reservations `0`, pending revocations `0`.
- Repository source/document Secret scan -> exit `0`, `782` files scanned,
  suspicious raw credential matches `0`.
- External Manifest value scan -> exit `0`, suspicious raw credential matches
  `0`; it retains only the fixed OAuth Client Secret Reference.
- Current restart log scan -> exit `0`, eight files scanned, suspicious raw
  credential matches `0`.
- Secret Store ACL is inheritance-protected and grants Full Control only to the
  current Windows user and `SYSTEM`.

LIVE-003 safety result:

- Gmail Provider send calls: `0`.
- Gmail Send Intents and Send Attempts: `0`.
- DataForSEO calls: `0`.
- AI Provider calls: `0`.
- External Browser Provider calls: `0`.
- No raw Client Secret, Token, authorization code, PKCE verifier, API key, or
  mailbox password is stored in the repository, Manifest, result ledger,
  PostgreSQL business fields, or current runtime logs.
- Final Gmail connection state is `CONNECTED`; Gmail Send and Sync remain
  disabled until LIVE-004 starts.

## LIVE-004 Gmail Local Product Acceptance

Execution boundary and result:

- Final verification: `2026-08-02T23:57:24+08:00`.
- Result: `PASS`.
- `GMAIL_LOCAL_PRODUCT_ACCEPTANCE = PASS`.
- This is local product acceptance only. It is not public deployment,
  production-release approval, or completion of `LIVE-GATE`.
- The real browser used Frontend `http://localhost:5173`; all browser business
  requests passed through FastAPI `http://localhost:7200`; Core remained private
  at `127.0.0.1:7301`.

Controlled send evidence:

- Draft `75b1ccbc-a674-41c8-84cf-66b68031a229` produced immutable approved
  version `7d0988e4-a906-4f55-865c-8dcd3da808a3`.
- Send Intent `84860e44-87f5-4e6f-a941-f87cd2b0da44` and Send Attempt
  `8f98ded2-aadc-4a98-9ec4-32359ee2672e` both reached
  `PROVIDER_ACCEPTED`; the attempt number is exactly `1`.
- Temporal send Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-send:v1:84860e44-87f5-4e6f-a941-f87cd2b0da44`
  completed as Run `019fc233-ef90-788c-887d-afcf0c486078`.
- Gmail accepted Provider Message ID `19fc233ffc368aa6` and Provider Thread ID
  `19fc233ffc368aa6`. The persisted attempt RFC Message-ID is
  `<84860e44-87f5-4e6f-a941-f87cd2b0da44.1@send.growthos.invalid>`.
- The authorized recipient is recorded only as `5***@qq.com`. The subject was
  `GrowthOS Gmail Canary + 2026-08-02T10:59:53Z`; the approved body was the
  fixed controlled Canary text.
- PostgreSQL contains exactly one Send Intent, one Send Attempt, and one
  completed Gmail send Temporal Workflow. No second send was attempted.

Receipt, reply, polling, and projection evidence:

- The user confirmed receipt and completed the manual reply in the controlled
  recipient mailbox.
- Reply polling Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-polling-sync:v1:5d0b8816-563e-42c6-a2ef-80ff268cf8e9`
  completed as Run `019fc318-3bd0-7827-b993-c86019459b8a` with one raw message,
  one projected message, one inbound projection, and one confirmed match.
- The persisted thread is `a17e9ae8-d99e-4087-94e6-5f0cc4e0930f`. Outbound
  message `e1b1e081-0348-46ee-b266-3a96c4996ff3` and inbound message
  `e183f60d-53a1-4b5e-83de-03b9e696ff33` share Provider Thread ID
  `19fc233ffc368aa6`.
- Inbound fact `ff415fae-0fa0-4dc1-9689-abc864d32d35` produced confirmed match
  candidate `ef064239-2420-4757-9663-16068421ac9c` for Opportunity
  `44444444-4444-4444-8444-444444444441`, using Provider thread and RFC reply
  header evidence.
- The real Email Center displayed the original outbound message and the
  received reply as one two-message thread and showed the confirmed Opportunity
  association. No route interception, Mock, Fake, or fixture runtime was used.

Dedupe, RLS, restart, and shutdown-control evidence:

- A second real browser refresh started Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-polling-sync:v1:23a47d3b-0af6-49b3-9ca5-e6d6430f9742`;
  Run `019fc31b-c024-7054-afa0-d96d971ab54f` completed with zero new raw
  messages, projections, inbound facts, or matches.
- Five Gmail polling Workflows and one Gmail send Workflow are retained in
  Temporal, all `COMPLETED`. The last polling replay left PostgreSQL counts
  unchanged.
- Application-role verification ran as `growthos_backlinks_canary` with
  `row_security=on`: Send Intents `1`, Send Attempts `1`, raw references `2`,
  threads `1`, messages `2`, inbound messages `1`, match candidates `1`, and
  sync cursors `1`.
- An alternate Workspace/Project context returned messages `0`, inbound
  messages `0`, and Send Intents `0`.
- The complete application stack stopped gracefully at
  `2026-08-02T23:35:54+08:00` and restarted as run `20260802-233604`.
  Post-restart listeners were Frontend `127.0.0.1:5173`, FastAPI
  `127.0.0.1:7200`, private Core `127.0.0.1:7301`, PostgreSQL
  `127.0.0.1:55432`, and Temporal `127.0.0.1:57233`; all HTTP health/readiness
  checks returned `200`.
- Post-restart FastAPI request `req-u` returned two mail messages, one inbound
  and one outbound. Request `req-v` returned all five Provider Kill Switches
  blocked: `GMAIL_SEND`, `GMAIL_SYNC`, `backlinks.dataforseo.v1`,
  `AI_PROVIDER`, and `BROWSER_PROVIDER`.
- A no-body polling request after `GMAIL_SYNC` was blocked returned HTTP `409`
  with `BACKLINK_CONFLICT`; Temporal counts remained five polling Workflows and
  one send Workflow.
- Active jobs, active rate-limit reservations, active Provider leases, and
  transient OAuth session files are all `0`. The valid encrypted Gmail Token
  Set remains in the protected repository-external Secret Store so the final
  connection remains `CONNECTED`.

Final verification:

- Core `npm run verify:backlinks` -> exit `0`: Unit `421`, API `88`, Contract
  `153`, Integration `173` passed with `13` explicit environment skips,
  Security `102`, and Resilience `8`.
- Core build -> exit `0`.
- FastAPI Ruff -> exit `0`; pytest -> exit `0`, `55 passed`, `1 skipped`;
  Python compile verification -> exit `0`.
- Frontend typecheck, lint, and production build -> exit `0`; source tests
  passed `39`.
- Repository credential-pattern scan: `847` files, suspicious credential
  matches `0`.
- External runtime environment/log scan: `166` files, suspicious credential
  matches `0`. The Manifest scan also returned `0` and confirmed only Secret
  References, `syncMode=polling`, and `maxSendCalls=1`.
- Secret Store contains encrypted/versioned values only; ACL validation found
  no principal other than the current Windows user and `SYSTEM`.

## External Effects

- Gmail Provider send calls: exactly `1`
- Gmail polling Workflow executions: `5`, all completed; exact low-level Gmail
  read HTTP request count is not claimed
- Google OAuth operations: one controlled local-product connection,
  disconnect, and reconnect sequence retained from LIVE-003
- DataForSEO calls and cost: `0`, `0` currency units
- Real AI Provider calls and cost: `0`, `0` currency units
- External Browser Provider calls: `0`
- Local non-production PostgreSQL/Temporal persistent resources: created and
  retained
- Repository-external Canary secrets and encrypted Gmail Token Set: retained;
  transient OAuth/session artifacts: `0`
- Production database/resource mutation: `0`
- Git commit/push/pull/merge/rebase/reset: `0`

## Next Action

`LIVE-001`, `LIVE-002`, `LIVE-003`, and `LIVE-004` are `PASS`.
`GMAIL_LOCAL_PRODUCT_ACCEPTANCE = PASS`. Execution stops here as authorized;
`LIVE-005`, `LIVE-006`, and `LIVE-GATE` remain `NOT_STARTED`. No public
production deployment or full LIVE-GATE result is claimed.
