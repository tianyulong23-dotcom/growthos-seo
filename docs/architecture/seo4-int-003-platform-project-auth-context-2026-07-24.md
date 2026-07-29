# SEO4-INT-003 Platform Project, Auth, And Context Integration

Date: `2026-07-24`

Task result: `SEO4-INT-003 = DONE`

## Frozen Evidence

- local checkout: `main@a9380e70a571b722f0ffdbfdb7b0adfc318faee4`;
- coworker baseline: `origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`;
- branch relation: local is 0 ahead and 1 behind;
- the coworker `Project` and `SiteProfile` model blob is
  `ae33e0151c613bb63656d9e8af353a8808b72967` in both the fetched baseline
  and the integrated local file;
- no pull, merge, rebase, checkout, commit, or push occurred.

`SEO4-INT-001` and `SEO4-INT-002` are the proven prerequisites. Their
inventory and conflict decisions remain unchanged.

## Authority Decision

| Surface | Decision | Evidence |
|---|---|---|
| Website Project master data | `KEEP`: Platform remains the only authority for the coworker `projects` and `site_profiles` models. | `PROVEN` |
| Project lookup used by Backlinks context | Add a read-only SQLAlchemy authority over `projects.id`; canonical `websiteProjectKey` is the authoritative Project ID. | `PROVEN` |
| Project writes | No create, update, delete, route, service, or second Project CRUD was added. | `PROVEN` |
| Authentication | Consume a short-lived, HMAC-SHA256-signed `PlatformAccessToken.v1`; browser-supplied internal context headers are not identity. | `PROVEN` contract and verifier |
| Membership | Resolve organization, workspace, project grants, roles, and permissions from the signed membership claims, then bind them to the authoritative Project row. | `PROVEN` |
| Platform context | Resolve Actor, Tenant, Project, permissions, and correlation ID on the FastAPI server, then reuse the existing signed `PlatformRequestContext.v1` producer and Backlinks consumer. | `PROVEN` |
| Default configuration | Keep `RejectingPlatformContextResolver` unless both the auth-token verification key and internal context-signing key are configured. | `PROVEN` |
| Production identity issuer | No production identity call or token issuer was added. Deployment identity, revocation, rotation, and secret provisioning remain external gates. | `UNKNOWN` |

## Real Project And Auth Contract

`PlatformAccessToken.v1` contains:

- fixed audience `growthos-platform-gateway`;
- issuer, issued-at, expiry, Actor user/session IDs;
- one or more memberships with organization ID, workspace ID, roles,
  permitted Project IDs, and permissions;
- strict schemas with unknown fields and duplicate values rejected;
- maximum token lifetime enforced by Platform configuration.

The FastAPI resolver:

1. verifies the Bearer token signature, issuer, audience, timestamps, and
   strict payload;
2. reads the Website Project from the coworker `projects` model;
3. requires one signed membership matching the Project organization and
   granting the requested Project ID;
4. requires `backlinks:read` for `GET`/`HEAD` and `backlinks:write` for other
   methods;
5. requires a non-blank request or correlation ID;
6. creates the existing `ResolvedPlatformRequestContext`;
7. lets the existing Gateway sign and forward only the server-resolved
   `PlatformRequestContext.v1`.

The resolver does not trust browser-supplied
`x-growthos-platform-context` or
`x-growthos-platform-context-signature`. The Gateway continues to remove the
browser Authorization header and any forged internal context before forwarding
the server-signed context to Backlinks Core.

## Retained And Replaced Capabilities

### Retained

- the coworker `Project` and `SiteProfile` ORM definitions are retained
  byte-for-byte;
- the fetched coworker Project routes, service, and Alembic revisions remain
  protected integration candidates;
- the existing FastAPI Backlinks Gateway, request forwarding, internal context
  signing, and transport failure behavior remain intact;
- the Backlinks Core fail-closed context consumer remains intact;
- the default rejecting resolver remains the active behavior when deployment
  secrets are absent.

### Replaced Or Rejected

- The coworker service default
  `default_organization_id = "local"` is not adopted as authorization. It
  cannot prove authentication, membership, tenant isolation, or Project
  access.
- Browser-provided internal context headers are rejected as authority. Only
  signed authentication facts resolved by FastAPI may produce internal
  context.
- The default rejecting resolver is conditionally replaced only when both
  verification/signing keys are explicitly configured. Missing configuration
  continues to fail closed.

The full coworker Project route/service import is deferred because it currently
depends on the unauthenticated local organization default and also composes
Crawler, Audit, Temporal, and object-storage capabilities owned by later
integration tasks. Importing it here would cross the task boundary and weaken
the single-Project-writer rule.

## Changed Files

Implementation:

- `backend/api/app/core/platform_auth.py`
- `backend/api/app/core/authoritative_platform_context.py`
- `backend/api/app/modules/projects/models.py`
- `backend/api/app/modules/projects/authority.py`
- `backend/api/app/core/backlinks_gateway.py`
- `backend/api/app/api/routes/backlinks.py`
- `backend/api/app/core/config.py`
- `backend/api/app/main.py`
- `backend/api/.env.example`

Contracts and tests:

- `backend/contracts/json-schema/platform-access-token.v1.schema.json`
- `backend/api/tests/test_authoritative_platform_context.py`
- `backend/api/tests/test_platform_auth_contract.py`
- `backend/api/tests/test_project_authority.py`
- `backend/api/tests/test_backlinks_gateway.py`
- `backend/api/tests/shared_runtime_app.py`

Governance:

- `docs/architecture/seo4-int-003-platform-project-auth-context-2026-07-24.md`
- `docs/architecture/shared-module-ownership.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

## Verification

| Check | Result |
|---|---|
| Test-first collection before implementation | Exit 1: the new resolver, Project authority, and resolver factory did not exist. |
| FastAPI full pytest | Exit 0: `23 passed`. |
| FastAPI Ruff check | Exit 0: `All checks passed!`. |
| Ruff format check over 13 task-touched Python files | Exit 0: `13 files already formatted`. |
| Backlinks contract suite | Exit 0: 8 files and 49 tests passed. |
| Disposable shared-runtime isolation | Exit 0: 7 Gateway routes; one Backlinks command; Platform health and Audit probe remained 200 after Backlinks stopped; Backlinks returned exact 503. |
| Project model provenance | Exit 0: local and remote blobs both equal `ae33e0151c613bb63656d9e8af353a8808b72967`. |
| Project authority write/Backlinks SQL scan | Exit 0: zero insert, update, delete, DDL, or `backlinks.*` matches. |

The tests cover:

- valid signed Actor/Membership/Project/Permission resolution;
- forged token rejection;
- expired token rejection;
- cross-tenant rejection;
- cross-workspace ambiguity and missing Project grant rejection;
- cross-project rejection;
- method-specific write permission rejection;
- forged internal-context header non-authority;
- default configuration fail-closed behavior;
- strict auth/membership JSON contract;
- read-only lookup through the coworker `projects` model.

## Remaining Gates

| Item | Status |
|---|---|
| Production identity issuer and session revocation | `UNKNOWN` |
| Production signing-key storage, rotation, and distribution | `UNKNOWN` |
| Live Project database schema and migration application | `UNKNOWN`; owned by `SEO4-INT-004` |
| Authenticated coworker Project route/service aggregation | `PENDING`; owned by `SEO4-INT-005` |
| Aggregate public OpenAPI and Route Gate | `PENDING`; owned by `SEO4-INT-005` |
| Authenticated external GitHub owner approval | `UNKNOWN` |

The repository-local ownership record triggers
`ROLE-PLATFORM-API`, `ROLE-PLATFORM-CONTEXT`,
`ROLE-PLATFORM-CONTRACTS`, and the Backlinks consumer review. These roles are
assigned locally to `tianyulong23-dotcom`. This is not an authenticated GitHub
approval from the coworker repository owner.

`SEO-V4-ROUTE-GATE` remains pending because `SEO4-INT-005` has not been
executed. The next task in the prescribed route sequence is `SEO4-INT-005`.
`SEO4-INT-004` is independently allowed by its prerequisite, but it was not
executed here.

No frontend synchronization, paid Provider call, supplied credential use,
production identity call, local or production database mutation, dependency
change, commit, or push was performed.
