# PB-C1-GMAIL-AUTH Result

Status: INTEGRATED
Workspace: C:\Users\DELL\Documents\缝合\john3947-seo
Integrated at: 2026-07-27T15:24:01+08:00
Tasks: BL-AI-099..106

## Scope

- Integrated the Gmail connection and verified identity capability only.
- Added no Gmail message construction, send execution, reply synchronization,
  automatic sending, BL-AI-107, or PB-C2 implementation.
- Real Google OAuth/Gmail requests, supplied credentials, production database
  operations, Git commit, and Git push remained disabled.

## Integrated Capability

- `backlinks-0012` is registered after `backlinks-0011` and before
  `backlinks-0013` in the deployment manifest and PostgreSQL 18 verification.
- OAuth attempts are tenant-bound, expiring, one-time, state-hashed, and
  PKCE-bound. Forged, replayed, expired, and cross-tenant consumption fails.
- The Google auth Port and deterministic Fake cover authorize, callback,
  refresh, and revoke. The real client shell is disabled by default, has no
  built-in HTTP execution, enforces the redirect allowlist, and fixes V1A
  scopes to `openid email profile gmail.send`.
- Callback completion transactionally persists the Gmail Connection, active
  Workspace Binding, opaque Secret Reference, and accepted verified OIDC
  primary Send Identity.
- Refresh rotates Secret References under a PostgreSQL advisory lock and
  optimistic versioning. A 20-contender test proved one refresh owner.
- Disconnect pauses local sending and removes the active credential reference
  before remote revoke retry and final Secret Store deletion.
- From and Reply-To authorization accepts only current, accepted identities
  belonging to the same Organization and Gmail Connection.
- Fastify exposes connect, callback, status, and disconnect. FastAPI forwards
  those routes without duplicating Backlinks business logic.
- Backlinks OpenAPI now contains 21 paths. The aggregate contains 43 public
  paths and 47 operations with unique operation IDs.

## Principal Files

- Domain and Ports:
  `domain/sending/oauth-attempt.ts`, `domain/sending/identity.ts`,
  `ports/google-auth.port.ts`, and `ports/secret-store.port.ts`.
- Adapters and Application:
  `adapters/gmail/auth-fake.adapter.ts`, `adapters/gmail/auth-client.ts`,
  Gmail connection Commands, Queries, Secret service, disconnect Workflow,
  and Gateway contracts.
- Persistence:
  `db/migrations/0012_backlink_gmail_connections.sql`,
  `db/schema/gmail-connections.ts`, tenant transaction helper, OAuth attempt
  repository, and Gmail connection repository.
- Shared registration:
  private Fastify server, Backlinks OpenAPI generator, FastAPI Backlinks
  gateway routes, aggregate OpenAPI, deployment manifest, and PostgreSQL 18
  verification contracts.
- Tests:
  OAuth/Google auth/Secret Store/identity Unit and Contract tests; Gmail route,
  migration, repository, disconnect resilience, FastAPI gateway, shared
  contract, deployment manifest, and PostgreSQL 18 tests.

## Verification

| Command | Exit code | Result |
|---|---:|---|
| `npm exec -- vitest run test/backlinks/integration/gmail-auth-repositories.test.ts` | `0` | 3/3 passed against disposable PostgreSQL |
| focused Gmail API/migration/repository/contract/unit suites | `0` | All focused PB-C1 tests passed |
| `npm run verify:backlinks` | `0` | Unit 128/128; API 55/55; Contract 75/75; Integration 95 passed and 13 gated skips; Security 95/95; Resilience 3/3 |
| Backlinks OpenAPI check | `0` | 21 paths |
| aggregate shared-contract check | `0` | 43 public paths, 47 operations |
| focused FastAPI gateway/shared/migration pytest | `0` | 15/15 passed |
| `powershell -ExecutionPolicy Bypass -File backend/database/tests/verify-postgresql18.ps1` | `0` | PostgreSQL 18.4 clean install, prior-data upgrade, historical read, backup, restore, RLS, and schema contracts passed |

## External Effects

- Real network: none.
- Google OAuth/Gmail: none.
- Supplied credentials or plaintext tokens: none.
- Production or persistent database: none.
- Ephemeral infrastructure: disposable PostgreSQL 17/18 and existing test
  runtime only; verification scripts removed their labeled resources.
- Production resource: none.
- Gmail send: none.
- Git commit/push: none.

## Remaining Boundaries

- Real Google consent, OIDC claims, token refresh, `invalid_grant`, and remote
  revoke behavior remain unverified until an explicitly authorized canary.
- Gmail Send As alias discovery still requires later incremental
  `gmail.readonly` consent and accepted alias verification.
- Message construction and Gmail submission remain PB-C2 work. PB-C2 may now
  use the satisfied prerequisites `PB-C1-GMAIL-AUTH = INTEGRATED` and
  `BL-AI-096 = INTEGRATED`, but it was not started in this execution.

## BL-AI-099 Re-execution - 2026-07-27

- Re-read the authoritative V1.4 task card and re-audited only the
  Gmail Connection, OAuth Attempt, Secret Reference schema, Migration 0012,
  related tests, manifest registration, and integration evidence.
- The integrated implementation already satisfied the BL-AI-099 acceptance
  contract. No application, schema, migration, or manifest source change was
  required.
- Migration 0012 remains byte-identical to its registered SHA-256
  `644a10e33e6712fe3e69f7ff14d003666248219c2a61837f105c907e1e6957b4`
  and remains ordered after 0011 and before 0013.

| Re-execution check | Result |
|---|---|
| Focused Gmail migration suite | PASS, 4/4 |
| Full Core verification before the unrelated PB-C2 handoff changed Migration 0014 | PASS: Unit 138/138; API 55/55; Contract 75/75; Integration 102 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| Focused FastAPI Gateway/shared contracts | PASS, 12/12 |
| FastAPI Ruff | PASS with `--no-cache` in the read-only container |
| Production dependency audit | PASS, 0 vulnerabilities across 603 packages |
| BL-AI-099 disposable PostgreSQL 18.4 proof | PASS: applied 0001 through 0012 and verified six owned forced-RLS tables, opaque Secret References, exact V1A scopes, 10-minute TTL, state uniqueness, one-time consumption, active Google-subject uniqueness, and tenant visibility |
| Full repository PostgreSQL 18 deployment gate | EXTERNAL BLOCKER: the concurrent BL-AI-109 handoff changed forward-only Migration 0014 from manifest SHA `e95a3de354bbffdf902b59827378b7fd6cbae00aec0fc8f5331a2f5b5af0f0b5` to `269be10e840ddc5b4e231602b16e5ec9ba1a48ae8809efbfd7f6e7564a1d11f9`; this BL-AI-099 execution did not integrate or revert that later task |

No real Google OAuth/Gmail call, supplied credential, plaintext token,
production or persistent database operation, Gmail send, Git commit, or Git
push occurred. Execution stopped at BL-AI-099; BL-AI-100 was not re-executed.

## BL-AI-100 Re-execution - 2026-07-27

- Re-read the V1.4 BL-AI-100 task card and re-audited the OAuth Attempt domain,
  one-time PostgreSQL repository, Secret Store boundary, and focused tests.
- The integrated backend already satisfies the task contract: OAuth state and
  browser-session values are stored as SHA-256 hashes, PKCE uses S256, the
  verifier is stored only behind an opaque Secret Reference, attempts expire
  after 10 minutes, and consumption is atomically bound to Organization,
  Workspace, Website Project, user, state, and browser session.
- Forged state, replay, expiry, cross-tenant/cross-user/cross-session use, and
  parallel double-consumption fail closed. No backend source change was
  required.
- Added a read-only, feature-private frontend projection for BL-AI-099/100
  under `frontend/src/features/outreach/gmail/`. It exposes only the
  authorization safety contract and keeps Connect and Send unavailable. It
  contains no access token, refresh token, PKCE verifier, credential input, or
  network action.

| Re-execution check | Result |
|---|---|
| Focused OAuth Attempt Unit suite | PASS, 6/6 |
| Focused OAuth Attempt PostgreSQL repository suite | PASS, 3/3 after one transient Docker Hub digest-resolution timeout |
| Full Core `verify:backlinks` | PASS: Unit 143/143; API 55/55; Contract 75/75; Integration 105 passed with 13 environment-gated skips; Security 95/95; Resilience 3/3 |
| Core manifests and contracts | PASS: source manifest 21/21, licenses 603 packages, Backlinks OpenAPI 22 paths |
| Frontend BL-AI-099/100 source contract | PASS |
| Current frontend gates | PASS: typecheck, full ESLint, production build, and Draft/Gmail source contracts 3/3 |
| Browser proof | PASS at `1440x900` and `390x844`; no horizontal overflow, console error, or console warning |

The V1.4 protected-file rule was preserved by this execution: the new
foundation remains feature-private and was not registered in
`outreach-workspace.tsx`, `App.tsx`, the app shell, the global API client, or
global CSS. A separate concurrent task changed `outreach-workspace.tsx` and
other Gmail files after this execution began; those changes were neither
authored, reviewed, reverted, nor counted as BL-AI-100 evidence here.
`PB-FE-GMAIL` BL-AI-121/122 remains outside this execution.

No real Google OAuth/Gmail call, supplied credential, plaintext token,
production or persistent database operation, Gmail send, Git commit, or Git
push occurred.
