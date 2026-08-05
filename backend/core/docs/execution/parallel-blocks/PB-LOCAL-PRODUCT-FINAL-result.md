# PB-LOCAL-PRODUCT-FINAL Result

Status: PASS_LOCAL_PRODUCT
Current phase: LP-FINAL-GATE
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`
Started: `2026-08-03T09:50:15+08:00`
Target: `PASS_LOCAL_PRODUCT`

## Serial Status

| Phase | Status | Evidence |
| --- | --- | --- |
| `LP-FINAL-001` | PASS | Baseline, persistent services, migrations, RLS, Provider controls, and three-stack tests recorded below |
| `LP-FINAL-002` | PASS | Opportunity Contact selection, contact/version-bound drafts and SendIntents, immutable SendSnapshot, approval invalidation, 30-day initial-outreach rule, migration `0035`, and three-stack contracts verified |
| `LP-FINAL-003` | PASS | Real AI SDK adapter, evidence-safe prompt composition, formal Draft Job/Temporal execution, budget and Kill Switch controls, manual fallback, and full Core verification passed |
| `LP-FINAL-004` | PASS | Independent, fail-closed `LOCAL_PRODUCT` capability composition, dynamic Project Context/OAuth callback, loopback-only Gateway/Core boundaries, and full three-stack verification passed |
| `LP-FINAL-005` | PASS | Opportunity-driven compose, formal Contact selection, AI/manual Draft lifecycle, approval/final confirmation, persistent send status, responsive and keyboard-accessible product flow, and Email Center integration verified |
| `LP-FINAL-006` | PASS | One-command persistent local-product lifecycle, readiness, graceful stop, cold restart, and conflict handling verified |
| `LP-FINAL-GATE` | PASS | Real AI Draft, human approval, immutable SendSnapshot, exactly one Gmail send, recipient reply, polling sync, Email Center display, full restart persistence, Temporal replay dedupe, RLS isolation, closed Provider switches, and full automated verification passed |

## LP-FINAL-001 Baseline And Site Protection

Status: PASS
Captured at: `2026-08-03T09:50:15+08:00`

### Repository

- Branch: `外链part`
- HEAD: `8e056945975093c2c720e944fca6666c2638ece3`
- Existing working tree was dirty before this block and remains protected:
  `195` porcelain status entries, `137` tracked changed files, and `306`
  untracked files were observed.
- The pre-existing tracked diff was `29,454` insertions and `8,490` deletions
  across `137` files. No existing user change was reverted or overwritten.
- No commit, push, pull, merge, rebase, or reset was executed.

### Authoritative Inputs Read

- `GrowthOS-外链板块后端Coding计划-V1.2-开源接入执行版-2026-07-21.md`
- `GrowthOS-外链板块AI分步Coding指令手册-V1.2-SEO-V4融合补丁-2026-07-24.md`
- `方案1-第6阶段-AI开发信草稿-开源调查与POC报告-2026-07-16.md`
- `方案1-第9阶段-发送审核与正式发送-开源调查与POC报告-2026-07-17.md`
- `GrowthOS-DataForSEO-Cost-Control与Coding最终实施方案-V1.0-2026-07-30.md`
- `backend/core/docs/execution/DFS-COST-V1.4.2-result.md`
- `backend/core/docs/execution/parallel-blocks/PB-LIVE-ACTIVATION-result.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`
- `ops/live/LIVE-001-runbook.md`

Historical `PB-LIVE-ACTIVATION` evidence was read but not modified.

### Persistent Runtime

| Component | Endpoint / resource | Process evidence | Health |
| --- | --- | --- | --- |
| Frontend | `127.0.0.1:5173` | Node/Vite PID `35768` | HTTP `200` |
| FastAPI Gateway | `127.0.0.1:7200` | Python PID `40940` | `/health` and `/ready` HTTP `200` |
| Private Fastify Core | `127.0.0.1:7301` | Node PID `43696` | `/health` and `/ready` HTTP `200` |
| Backlinks Worker | Temporal queue `growthos.backlinks.v1` | Node PID `41176` | Worker state `RUNNING` |
| PostgreSQL | `127.0.0.1:55432` | `growthos-live001-postgres` | PostgreSQL `18.4`, container healthy |
| Temporal | gRPC `127.0.0.1:57233`, metrics `127.0.0.1:59090` | `growthos-live001-temporal` | Namespace `growthos-backlinks-canary` registered |

PostgreSQL and Temporal continue to use their retained named volumes. Fastify
is loopback-only; no public Core listener was found.

### Database And Provider Controls

- Alembic database head: `20260724_0007`.
- Backlinks deployment manifest head: `0034`.
- Migration checker: `27` files through `0034`.
- Migration `0034` runtime objects are present:
  `backlink_claim_outbox_events` and `backlink_mark_outbox_event`.
- All `72` Backlinks tables have both RLS and forced RLS enabled.
- Application role `growthos_backlinks_canary` is `NOSUPERUSER`,
  `NOBYPASSRLS`, with role-level `row_security=on`.
- Effective project Kill Switches are blocked for `GMAIL_SEND`,
  `GMAIL_SYNC`, `AI_PROVIDER`, `backlinks.dataforseo.v1`, and
  `BROWSER_PROVIDER`.
- During LP-FINAL-001, real Gmail, AI, DataForSEO, external Browser Provider,
  GSC, Indexing API, and Sitemap API call counts were all `0`.

### Baseline Verification

Detailed command output is retained outside the repository under
`%LOCALAPPDATA%\GrowthOS\lp-final\logs`.

| Command | Exit code | Result |
| --- | ---: | --- |
| `npm run verify:backlinks` | `0` | Source manifest `28`; dependency allowlist valid; licenses `683`; migrations `27` through `0034`; Unit `421`; API `88`; Contract `153`; Integration `173` passed with `13` skips; Security `102`; Resilience `8` |
| `npm run build` in Core | `0` | TypeScript production build passed |
| `ruff check app tests` | `0` | All checks passed |
| `python -m pytest -q` | `0` | `55 passed, 1 skipped` |
| `npm run typecheck` in Frontend | `0` | Passed |
| `npm run lint` in Frontend | `0` | Passed |
| `npm run build` in Frontend | `0` | Vite production build passed; existing large-chunk warning only |
| `node --test` over 13 Frontend source test files | `0` | `44 passed` |
| Frontend/FastAPI/Core health probes | `0` | Five HTTP probes returned `200` after builds |

## Changed Files

- `backend/core/docs/execution/PB-LOCAL-PRODUCT-FINAL-execution-patch.md`
- `backend/core/docs/execution/parallel-blocks/PB-LOCAL-PRODUCT-FINAL-result.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

## External Effects

- Repository-external baseline logs were created under
  `%LOCALAPPDATA%\GrowthOS\lp-final\logs`.
- Persistent PostgreSQL, Temporal, and existing Gmail secret references were
  read only for baseline verification.
- No Provider capability was opened and no paid or email side effect occurred.

## LP-FINAL-002 Opportunity Contact And Immutable Send Snapshot

Status: PASS

### Product Contract

- Added the formal Opportunity Contacts query across private Core, FastAPI
  Gateway, generated OpenAPI clients, and the Frontend.
- Eligible recipients are restricted to the current Opportunity Prospect's
  `active`, `guessed=false`, non-invalidated Contacts under the same tenant and
  Website Project context.
- The UI auto-selects one eligible Contact, supports explicit choice among
  multiple Contacts, and directs the user to confirm a Contact when none are
  available.
- Draft creation, model runs, draft versions, SendIntents, and immutable send
  snapshots bind both `contactId` and `contactVersion`.
- SendIntent creation validates the approved Draft version, selected Contact
  version, Gmail identity, quota reservation, policy state, and the 30-day
  initial-outreach limit before creating the outbox event.
- The Worker loads recipient, subject, body, Opportunity, Draft version, Gmail
  connection, and Contact version only from the immutable SendSnapshot.
- Contact version changes invalidate prior approval. SendSnapshot mutation is
  rejected by PostgreSQL. A repeated logical SendIntent returns the original
  business fact and does not create a second snapshot, reservation, or outbox
  event.

### Migration And Persistent PostgreSQL

- Backlinks deployment head advanced from `0034` to `0035`; no historical
  migration was inserted or renumbered.
- Migration:
  `backend/core/src/modules/backlinks/db/migrations/0035_backlink_contact_send_snapshots.sql`
- SHA-256:
  `59d3165f4123def9dc32f8bc5b0656401b87eb67a4cbfa099e0f6c85562080ea`
- Migration `0035` was applied transactionally to the retained PostgreSQL 18
  database and committed successfully.
- `backlink_send_snapshots` is owned by the Backlinks owner role with RLS and
  forced RLS enabled. Tenant policies, immutable trigger, Contact approval
  invalidation trigger, and function `search_path=backlinks, pg_catalog` were
  verified in the persistent database.
- The restricted Canary application role remains `NOSUPERUSER`,
  `NOBYPASSRLS`, and `row_security=on`. Cross-Workspace snapshot visibility was
  zero in both directions.

### Verification

| Command / proof | Exit code | Result |
| --- | ---: | --- |
| `npm run verify:backlinks` | `0` | Source manifest `28`; dependency allowlist and license checks passed; OpenAPI `47` public paths; `28` migrations through `0035`; Unit `424`; API `92`; Contract `153`; Integration `176` passed with `13` skips; Security `102`; Resilience `8` |
| `npm run build` in Core | `0` | Production TypeScript build passed |
| FastAPI `ruff check app tests` | `0` | Passed |
| FastAPI `python -m pytest -q` | `0` | `55 passed, 1 skipped` |
| FastAPI migration tests | `0` | `4 passed` through Backlinks `0035` |
| Frontend typecheck, lint, build | `0` | All passed; existing Vite large-chunk warning only |
| Persistent PostgreSQL integration | `0` | Snapshot immutability, replay idempotency, 30-day rule, approval invalidation, and cross-project RLS passed |
| Frontend/FastAPI/Core probes | `0` | Frontend `5173`, Gateway health/readiness `7200`, and private Core health/readiness `7301` all returned HTTP `200` |

Real Gmail, AI, DataForSEO, external Browser Provider, GSC, Indexing API, and
Sitemap API call counts remained `0` during LP-FINAL-002. Provider Kill
Switches remained blocked. No Git history operation occurred.

## LP-FINAL-003 Real AI Draft

Status: PASS

### Product Composition

- Added the approved `ai@7.0.29` runtime dependency behind the existing
  `AiDraftPort` and `ModelAdapter` boundary. The adapter uses structured Zod
  output, no tools, no SDK retries, disabled telemetry, an explicit timeout,
  and at most one bounded schema-repair attempt.
- Draft prompts are rebuilt inside the tenant-scoped PostgreSQL repository from
  the current Project Context, Opportunity, cooperation types, approved
  Evidence Snapshot, and exact Contact role/purpose. The Contact email is never
  sent to the model and is retained only as a forbidden-output value.
- The formal Draft Job and Temporal Workflow now persist generation mode,
  Prompt/Schema/Model versions, Evidence references, token usage, estimated
  cost, repair count, refusal state, and immutable MODEL or MANUAL Draft
  Versions.
- MODEL generation is guarded by the project `AI_PROVIDER` Kill Switch,
  a fixed repository-external Secret Reference, model/token limits, a
  per-project advisory-locked budget reservation, and a second capability
  check immediately before each Provider attempt.
- When AI is disabled, the same formal Draft Job/Temporal path creates an
  editable `MANUAL` template. It cannot be labelled as MODEL output. All
  generated drafts enforce `requiresUserConfirmation=true` and
  `canAutoSend=false`.
- DataForSEO remains independent and disabled; Draft generation has no
  DataForSEO or GSC dependency.

### Dependency And Security Evidence

- `ai` is pinned exactly to `7.0.29`; the dependency allowlist and generated
  third-party notices were updated. License verification passed for `691`
  packages.
- The platform Secret Store resolves only
  `secret://growthos/local-product/ai/provider-credential/v1`; raw credentials
  are not accepted in runtime configuration.
- Timeout, HTTP 429, refusal, revoked capability, bad Secret Reference,
  invalid model/token/budget configuration, budget exhaustion, one repair,
  and aggregate usage/cost limits have focused tests.
- Real Gmail, AI, DataForSEO, external Browser Provider, GSC, Indexing API, and
  Sitemap API call counts remained `0` during this phase. Provider Kill
  Switches remained blocked.

### Verification

| Command / proof | Exit code | Result |
| --- | ---: | --- |
| Focused AI Unit/Contract tests | `0` | `5` files and `24` tests passed before the full gate |
| PostgreSQL Draft integration | `0` | `8/8` tests passed with formal Project Context and Contact-version checks |
| `npm run verify:backlinks` | `0` | Source manifest `28`; dependency allowlist valid; licenses `691`; OpenAPI `47` paths; migrations `28` through `0035`; Unit `428`; API `92`; Contract `161`; Integration `176` passed with `13` skips; Security `102`; Resilience `8` |
| `npm run build` in Core | `0` | Production TypeScript build passed |
| `git diff --check` | `0` | No whitespace errors; only existing Windows line-ending notices |

No Git history operation occurred.

## LP-FINAL-004 Local Product Runtime Mode

Status: PASS

### Runtime Contract

- Added `BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT` while preserving
  `LOCAL_PRODUCT_ACCEPTANCE` as a historical compatibility mode.
- `LOCAL_PRODUCT` is loopback-only and rejects a stale
  `BACKLINKS_LIVE_CANARY_STAGE`. It uses the configured platform Organization,
  Workspace, Website Project, User, and Session rather than the historical
  `live001-canary` identity.
- Gmail Send, Gmail Sync, AI, DataForSEO, and Browser capability flags are
  independent. Credential-backed capabilities require the repository-external
  Platform Secret Store; Gmail capabilities additionally require Google OAuth.
  Invalid dependencies fail closed.
- The Google OAuth callback is derived from the current Website Project key:
  `http://localhost:7200/api/v1/projects/{projectKey}/backlinks/gmail-connections/callback`.
  The historical fixed callback remains limited to
  `LOCAL_PRODUCT_ACCEPTANCE`.
- FastAPI remains the only browser Gateway on `localhost:7200`; the private
  Fastify Core remains fixed to `127.0.0.1:7301`. The frontend API base remains
  `http://localhost:7200`.
- Frontend local-project selection now comes from
  `VITE_WEBSITE_PROJECT_KEY`, with optional real name/domain metadata. No
  fabricated `example.invalid` project is created for `LOCAL_PRODUCT`.

### Verification

| Command / proof | Exit code | Result |
| --- | ---: | --- |
| Focused Core capability tests | `0` | `21/21` passed, including independent flags, dynamic callback, stale-stage rejection, and credential dependencies |
| Focused FastAPI configuration/context tests | `0` | `19/19` passed |
| `npm run verify:backlinks` | `0` | Source manifest `28`; dependency allowlist valid; licenses `691`; OpenAPI `47` paths; migrations `28` through `0035`; Unit `432`; API `92`; Contract `161`; Integration `176` passed with `13` skips; Security `102`; Resilience `8` |
| FastAPI `ruff check .` | `0` | All checks passed |
| FastAPI `python -m pytest -q` | `0` | `62 passed, 1 skipped` |
| Frontend typecheck, lint, build | `0` | All passed; existing Vite large-chunk warning only |
| `git diff --check` on LP-FINAL-004 files | `0` | No whitespace errors; only Windows line-ending notices |

Real Gmail, AI, DataForSEO, external Browser Provider, GSC, Indexing API, and
Sitemap API call counts remained `0` during LP-FINAL-004. No Provider Kill
Switch was opened, and no Git history operation occurred.

## LP-FINAL-005 Complete Frontend Product Flow

Status: PASS

### Product Flow

- The Opportunity detail page now enters compose with the real
  `opportunityId`; users are never asked to paste an internal UUID.
- Compose loads the Opportunity Prospect's formal active, non-guessed
  Contacts. A single Contact is selected automatically, multiple Contacts are
  selectable, and an empty result directs the user to confirm a Contact before
  drafting.
- Draft generation and display retain the exact Contact and Contact Version,
  evidence, generation state, editable content, immutable Draft Version, and
  MODEL or MANUAL origin. No raw Contact email is placed in model evidence or
  telemetry.
- Approval, recipient confirmation, Gmail identity confirmation, and the final
  send confirmation are separate explicit actions. The confirmation displays
  the immutable recipient, Contact Version, Draft Version, and Gmail
  Connection that will form the SendSnapshot.
- A new read-only SendIntent projection exposes durable queued, sending,
  provider-accepted, unknown, and failed states plus correlated attempt,
  workflow, and provider identifiers. It does not expose the recipient.
  Unknown delivery results explicitly prohibit automatic re-send.
- Email Center continues to read server projections for real threads, inbound
  replies, reply matching, sync state, and recovery state. No fixed Canary
  recipient, fixed Canary body, or fabricated project is used by the product
  path.

### Accessibility And Responsive Evidence

- The Opportunity compose entry is a semantic link with the existing button
  styling; the rich-text editor has an explicit accessible name and status
  metadata uses valid definition-list structure.
- The full compose, generate, edit, approve, final-confirm, send-status, and
  Email Center path passed at desktop and exact `390x844` mobile dimensions.
  The mobile run found no horizontal page overflow or serious accessibility
  violation.
- The complete Opportunity-to-send path also passed using keyboard navigation
  without mouse input.

### Verification

| Command / proof | Exit code | Result |
| --- | ---: | --- |
| Core typecheck and focused SendIntent query/API tests | `0` | Durable SendIntent and SendAttempt status projection passed |
| FastAPI focused Gateway tests and Ruff | `0` | `16` focused tests passed; Gateway remains the browser boundary |
| Aggregate OpenAPI generation and contract checks | `0` | Backlinks `48` paths; Platform `70` public paths and `75` operations; Frontend client `48` operations |
| Frontend source tests | `0` | `40/40` passed with the source-only test enumeration |
| Frontend typecheck, lint, build | `0` | All passed; existing Vite large-chunk warning only |
| Desktop Playwright product flow | `0` | `1/1` passed |
| Mobile Playwright at `390x844` | `0` | `1/1` passed with no page overflow or serious accessibility issue |
| Keyboard and accessibility Playwright | `0` | `1/1` passed |
| `git diff --check` | `0` | No whitespace errors; only Windows line-ending notices |

Real Gmail, AI, DataForSEO, external Browser Provider, GSC, Indexing API, and
Sitemap API call counts remained `0` during LP-FINAL-005. Playwright used only
the controlled automated fixture graph and is not counted as the final real
Provider acceptance. No Provider Kill Switch was opened, and no Git history
operation occurred.

## LP-FINAL-006 One-Command Local Product Runtime

Status: PASS

### Implemented

- Added root `Start-GrowthOS-LocalProduct.ps1`,
  `Status-GrowthOS-LocalProduct.ps1`, and
  `Stop-GrowthOS-LocalProduct.ps1` entry points.
- Added the implementation and local-only runbook under `ops/local-product/`.
- Startup configures `BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT`, removes the legacy
  LIVE stage and fixed recipient variables, retains the protected external
  Gmail token store, and keeps DataForSEO and the external browser provider
  disabled. AI is enabled only when explicitly requested with complete
  repository-external configuration.
- Startup performs builds unless skipped, persistent PostgreSQL and Temporal
  startup, migration/RLS/namespace checks, independent process startup,
  readiness checks, and unmanaged port-conflict rejection.
- Shutdown gracefully terminates the product processes and stops containers
  without deleting PostgreSQL or Temporal volumes.
- Product Gmail polling supports multiple accepted product sends while retaining
  strict known-thread matching. Historical `LOCAL_PRODUCT_ACCEPTANCE` behavior
  remains isolated to its one-send Canary query.

### Verification

| Command / proof | Exit code | Result |
| --- | ---: | --- |
| PowerShell parse checks | `0` | All root and `ops/local-product` scripts parsed without errors |
| Core typecheck and unit suite | `0` | Typecheck passed; `78` files and `437` tests passed |
| Full start with Core and frontend builds | `0` | Builds completed and the six-service stack became ready |
| `Status-GrowthOS-LocalProduct.ps1` | `0` | Frontend `5173`, FastAPI `7200`, private Core `7301`, PostgreSQL 18 `55432`, Temporal `57233`, and Temporal metrics `59090` healthy |
| Migration checks | `0` | Platform Alembic `20260724_0007`; Backlinks manifest `0035` |
| Full graceful stop | `0` | Managed listeners removed; containers stopped; persistent named volumes retained |
| Cold restart | `0` | Complete stack returned healthy without data loss |
| Unmanaged `5173` conflict | expected rejection | Returned `LOCAL_PRODUCT_PORT_CONFLICT:5173` and did not terminate or replace the foreign process |
| Secret/log scan | `0` | No token, client secret, API key, OAuth code, or PKCE verifier disclosure |

Persistent row counts were unchanged across the full stop and cold restart:
Gmail connections `2` with `1` connected, drafts `1`, SendIntents `1`,
SendSnapshots `0`, mail threads `1`, and mail messages `2`. The protected
secret root remains outside the repository with access limited to the current
Windows user and `SYSTEM`.

Real Gmail, AI, DataForSEO, external Browser Provider, GSC, Indexing API, and
Sitemap API call counts remained `0` during LP-FINAL-006. No Git history
operation occurred.

### Gate Preconditions

- The active runtime now uses the local product project `elephtv`, not the
  historical `live001-canary` identity. The Website Project name is ElephTV
  and its configured domain is `elephtv.com`.
- Product Opportunity `39cc49b9-7488-42fc-b03a-c488640e5db3` exists for the
  controlled `qq.com` Prospect and has exactly one active, confirmed,
  `guessed=false` Contact. The recipient address remains outside this result
  file.
- At Gate entry, the retained Gmail connection and Workspace binding were
  healthy, while the current product Opportunity had no Draft, Model Run,
  SendIntent, SendSnapshot, or SendAttempt. This established the zero-side-
  effect baseline used to measure the controlled Gate closure below.

## LP-FINAL-GATE

Status: PASS_LOCAL_PRODUCT
Completed: `2026-08-03T23:43:40+08:00`

### Automated Verification

| Gate | Exit code | Result |
| --- | ---: | --- |
| Core `npm run verify:backlinks` | `0` | Source manifest `28`; licenses `692`; Backlinks OpenAPI `49` paths and private API `51` operations; `29` migrations through `0036`; Unit `446`; API `96`; Contract `165`; Integration `179` passed with `13` explicit skips; Security `102`; Resilience `8` |
| Core `npm run build` | `0` | Production TypeScript build passed |
| FastAPI Ruff | `0` | Full application and test tree passed |
| FastAPI pytest | `0` | `65 passed, 1 skipped` |
| Frontend source tests | `0` | `41/41` passed |
| Frontend typecheck, lint, build | `0` | All passed; the existing Vite large-chunk warning is unchanged |
| Frontend desktop Playwright | `0` | `2/2` controlled automated product flows passed using the installed local Chrome channel |
| Frontend mobile Playwright | `0` | Exact `390x844` product flow passed |
| Frontend keyboard/accessibility Playwright | `0` | Keyboard flow and accessibility assertions passed |
| PostgreSQL 18 acceptance | `0` | PostgreSQL `18.4` clean install, historical upgrade, DataForSEO schema-write compatibility, RLS, backup, and restore passed; `4` migration-manifest tests passed |
| PostgreSQL recovery timing | `0` | Restored `68` tables and `3` recovery facts; measured RPO `0.268s` and RTO `73.533s` |
| `git diff --check` | `0` | No whitespace errors; only existing Windows line-ending notices |

The Fake AI/Gmail automated E2E graph passed, but it is recorded only as
automated regression evidence and is not used as real Provider acceptance.
The PostgreSQL DataForSEO compatibility case validates database contracts
only; it did not make a paid Provider call. The Playwright package download
was unavailable within the bounded install window, so the same test suites
were rerun against the machine's installed Chrome channel and all passed.

### Live Local Runtime Evidence

- A full graceful Stop/Start loaded the final build and
  `Status-GrowthOS-LocalProduct.ps1` returned `status=ok` for run
  `20260803-230737` in `LOCAL_PRODUCT` mode.
- Frontend `127.0.0.1:5173`, FastAPI `127.0.0.1:7200`, private Core
  `127.0.0.1:7301`, PostgreSQL `127.0.0.1:55432`, Temporal
  `127.0.0.1:57233`, and Temporal metrics `127.0.0.1:59090` are independent
  loopback listeners. Frontend, both service health/readiness pairs, and
  Temporal metrics returned HTTP `200`.
- Persistent PostgreSQL and Temporal containers are healthy. Alembic remains
  at `20260724_0007`, Backlinks remains at `0036`, and the
  `growthos-backlinks-canary` Temporal Namespace is ready.
- The connected Gmail identity, approved Draft, SendIntent, SendSnapshot,
  Provider acceptance, thread, inbound reply, and match Projection remained
  present after the full restart.
- No Temporal Workflow is currently running.

### Product Facts And Provider Controls

- The ElephTV Opportunity and its eligible Contact count are `1/1`.
- Gmail connected connection and active Workspace binding counts are `1/1`.
- For the current product Opportunity, Drafts, Model Runs, SendIntents,
  SendSnapshots, and SendAttempts are `1/3/1/1/1`. The retained Draft is
  version `3`; approved immutable Draft Version
  `476d77b2-7418-4a3c-921c-614bb11c19f0` is bound to the selected confirmed
  Contact.
- The formal Temporal Draft path produced successful Model Run
  `473895e8-3408-4c48-af8d-a696d4a2706e` and Draft
  `a5d15190-100c-4f90-a887-6aefc27ae4f3`. The provider/model is
  `openai/gpt-5.6-sol`, Prompt/Schema versions are
  `backlinks-outreach-draft.v1/draft-document.v1`, usage is
  `4,859/250` input/output tokens, recorded cost is `USD 0.000636`, latency is
  `7,405ms`, and the run completed in one attempt with zero Schema repairs.
- Two preceding Model Runs failed closed (`TIMEOUT` and `MALFORMED_OUTPUT`).
  Their local usage ledger cost is `0`; provider-side billing for failed
  attempts remains an explicit reconciliation risk and was not blindly
  retried.
- Human approval and the final UI confirmation created SendIntent
  `f655e5db-6e59-4c08-8f39-555006a6a555`, immutable SendSnapshot
  `ff000dfb-69cd-4a45-89b4-72a33a81c80f`, and accepted Attempt
  `a811e4e7-c56e-45fa-823b-a45c53a310c0`. The send Outbox event
  `8f2a437f-5ec0-4540-ae9f-c2e43bb3625f` was published once with
  `attempt_count=1`.
- The send Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-send:v1:f655e5db-6e59-4c08-8f39-555006a6a555`
  completed as Run `019fc7f5-959e-7666-af2e-6f0b03c09051`. Gmail accepted
  exactly one Provider send call; its Provider Message and Thread identifiers
  were persisted. There was no unknown result, retry, or second send.
- The recipient confirmed receipt and sent a manual reply. Polling Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-polling-sync:v1:791faff9-c4af-458b-89b2-13d4ea897cd8`
  completed as Run `019fc821-f19e-78ca-a91a-f466e9eed4cd`, persisted two raw
  messages, projected one inbound reply, and matched it by the exact Provider
  thread with confidence `1`.
- Email Center displays the two-message thread. With sync disabled, refresh
  now retains persisted mail and shows the explicit paused-sync notice instead
  of replacing the page with an error.
- After restart, replay Workflow
  `backlinks:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:gmail-polling-sync:v1:dee4b271-b9f6-4ecb-a9e7-30bdf57e3356`
  completed as Run `019fc82d-d4a7-78b0-a4b9-5a82e4bc91db` with
  `already_completed` and zero new raw messages, Projections, inbound replies,
  or match candidates.
- Restricted application-role RLS returned target counts
  `1/1/1/1/1/2` for Draft/Contact/SendIntent/Snapshot/thread/messages.
  Alternate Workspace/Project reads and the unauthorized update all returned
  `0`; the role remains `NOSUPERUSER`, `NOBYPASSRLS`, and `row_security=on`.
- DataForSEO Provider Requests and Usage Ledger rows are `0/0`. GSC, Search
  Console, Indexing API, and Sitemap API calls are `0`.
- Effective project Kill Switches are blocked for `AI_PROVIDER`,
  `GMAIL_SEND`, `GMAIL_SYNC`, `backlinks.dataforseo.v1`, and
  `BROWSER_PROVIDER`. Active Provider fetch leases, bulk requests, budget
  reservations, pending/failed Outbox events, and running Workflows are all
  `0`.

### Secret And Cleanup Evidence

- The repository-external Secret Store has a protected ACL limited to the
  current Windows user and `SYSTEM`; inherited permissions were removed and
  the final ACL was revalidated. Its master key is `32` bytes and the retained
  OAuth material is stored in encrypted, versioned envelopes.
- No plaintext API key, OAuth token, authorization code, PKCE verifier, or
  client secret was detected in the retained runtime envelopes, current
  service logs, Manifest, or result files. Repository scan matches were
  limited to explicit security-test fixtures and field names.
- Fixed Canary recipient and fixed Canary body matches are `0` in the product
  source/runtime graph. Remaining `example.invalid` references are confined to
  historical compatibility guards and tests, not the `LOCAL_PRODUCT` path.
- The unused Docker network labelled `BL-AI-CC-003` from
  `2026-07-28` was removed after confirming it had zero attached containers.
- The PostgreSQL 18 Gate left one anonymous Docker volume created on
  `2026-08-03`; it was confirmed unmounted and removed by exact name.
  Task-created residual containers, networks, and anonymous volumes are `0`.
- The interrupted Playwright browser download left one empty repository-
  external `ms-playwright/__dirlock` directory. No Playwright install/test
  process or test listener remains; deletion was refused by the host execution
  policy, so the empty directory is retained as a non-runtime cleanup item.
- Docker still contains `65` dangling volumes that predate this block
  (`64` anonymous volumes created from `2026-07-22` through `2026-07-30` plus
  the named `growthos-uv-cache` volume). They were not mounted by the product
  stack and were preserved as pre-existing user resources rather than removed
  by a global prune.
- User browser processes were not terminated. No commit, push, pull, merge,
  rebase, or reset was executed.

### Credential Handling Event

- On `2026-08-03`, an AI Provider key was exposed in chat and a failed
  PowerShell command line before the protected importer was used. That exposed
  value must be rotated after this controlled acceptance.
- A company-account OpenAI-compatible credential was subsequently imported
  through the protected prompt into the repository-external encrypted Secret
  Store. Runtime configuration contains only the fixed Secret Reference and
  non-secret provider metadata.
- No raw API key was written to the repository, Manifest, result files, or
  current service logs. Repository and retained runtime scans found no
  credential value.
- PowerShell history entries containing the failed importer commands were
  removed and the clipboard was overwritten. The host-owned temporary
  attachment remains outside the repository and cannot be removed by the
  project process.

### Controlled Real Closure

The complete controlled path passed:

`Browser -> FastAPI Gateway -> private Core -> PostgreSQL/RLS -> Outbox ->
Temporal Worker -> Gmail/AI Provider -> PostgreSQL Projection -> FastAPI ->
Browser`.

The real product flow generated one AI Draft, required human editing/approval
and final send confirmation, made exactly one Gmail send call, received a
manual reply, synchronized and displayed the reply in Email Center, survived a
complete stack restart, and produced zero duplicate facts on replay.

`LP-FINAL-GATE = PASS_LOCAL_PRODUCT`.

This status means the GrowthOS Backlinks module passed controlled local-product
acceptance. It does not represent public production deployment, a production
domain, customer-data use, or commercial release approval.

Residual risks retained for explicit follow-up:

- Rotate the AI credential that was exposed before protected import.
- Reconcile Provider-side charges for the two failed AI attempts even though
  the local ledger recorded zero usage for them.
- The existing Vite large-chunk warning remains.
- The `65` pre-existing dangling Docker volumes remain untouched.
