# BACKLINKS-CORE-REMEDIATION-PHASE-M1A Result

Status: `INPUT_REQUIRED`

Date: `2026-08-15`

Task: `BACKLINKS-CORE-REMEDIATION-PHASE-M1A`

Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo-main`

## Decision

The M1A code and contract work is implemented and its focused static and
contract tests pass. The phase is not recorded as `PASS` for three reasons:

1. The exact owned-file list was established during the working session but
   was not written into this result before editing, as the implementation plan
   requires. This result does not backfill that procedural evidence.
2. The current Platform `projects` table is organization-scoped and has no
   persisted `workspace_id`. Production requests now resolve signed
   organization/workspace permissions before Project CRUD, but M1A cannot
   truthfully claim database-level Workspace isolation without the additive
   M1B migration.
3. Container-backed integration evidence is unavailable on this machine, and
   the local FastAPI virtual environment runs Python `3.12.13` while the
   repository requires Python `>=3.13`.

M1B and M1C were not started.

## Baseline And Final Git State

| Item | Value |
|---|---|
| Branch | `main` |
| Baseline commit | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| Final commit | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| Commit created | No |
| Push performed | No |
| Merge performed | No |

Pre-existing or separately owned dirty files were preserved:

- `docs/SEO自动化平台-UIUX需求文档-V1.2.md`
- `docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`
- `docs/architecture/backlinks-core-value-chain-remediation-v1.md`
- `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`
- `docs/architecture/backlinks-main-integration-compatibility-audit-v1.md`

## Owned And Changed Files

This is the reconstructed actual M1A ownership list. It was not persisted
before editing and therefore does not satisfy the plan's prerecord requirement.

### FastAPI Platform Project Authority

- `backend/api/app/api/routes/projects.py`
- `backend/api/app/core/authoritative_platform_context.py`
- `backend/api/app/core/backlinks_gateway.py`
- `backend/api/app/modules/onboarding/service.py`
- `backend/api/app/modules/projects/service.py`
- `backend/api/app/modules/projects/contracts.py`
- `backend/api/tests/test_authoritative_platform_context.py`
- `backend/api/tests/test_backlinks_gateway.py`
- `backend/api/tests/test_project_authority.py`
- `backend/api/tests/test_project_contracts.py`
- `backend/api/tests/test_projects.py`

### Backlinks Shared Evidence Contracts

- `backend/core/src/modules/backlinks/ports/shared-seo-evidence.port.ts`
- `backend/core/test/backlinks/api/shared-seo-evidence.test.ts`

### Frontend Exact Project Routing

- `frontend/package.json`
- `frontend/src/app/app-shell.tsx`
- `frontend/src/components/agent/agent-dock.tsx`
- `frontend/src/components/shared/page-header.tsx`
- `frontend/src/features/keywords/module.tsx`
- `frontend/src/features/outreach/module.tsx`
- `frontend/src/features/projects/project-authority-source.test.mjs`
- `frontend/src/features/projects/project-context.test.tsx`
- `frontend/src/features/projects/project-context.tsx`
- `frontend/src/features/projects/project-route.ts`
- `frontend/src/features/projects/project-switcher.test.ts`
- `frontend/src/features/projects/project-switcher.tsx`
- `frontend/src/pages/module-page.tsx`

### Result

- `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-M1A-result.md`

## Implemented Scope

### One Project Entry And Exact Frontend Identity

- Kept `/projects` as the Project-management and creation entry.
- Added one App Shell Project switcher using the same route Project ID.
- Removed the duplicate Agent Dock Project switcher/create surface.
- Removed first-Project fallback from production Project consumers.
- Added an exact route gate so an unknown/deleted Project cannot mount a
  module under another Project.
- Rejects cross-Project list, refresh, and business-profile responses.
- Cancels or ignores stale polling after Project switches.
- Added source guards against a Backlinks `projects` tab, production Mock
  Project workspace imports, and `projects[0]` fallback.

### Authenticated Project CRUD Authority

- Project routes use the configured Platform context resolver in production or
  auth-enabled mode.
- Collection and Project operations require explicit `projects:read` or
  `projects:write` permission.
- The resolved organization is passed into Project and onboarding services
  instead of silently using `default_organization_id`.
- Ambiguous collection membership across multiple Organization/Workspace
  scopes is rejected.
- Backlinks and Project CRUD use the same resolver/authentication authority.
- Local development retains an explicit local identity only when local auth is
  disabled.

This does not claim persisted Workspace ownership for Platform Project rows.
The existing Project model stores `organization_id`, not `workspace_id`.

### Frozen M1A Contracts

- Defined `ACTIVE`/`ARCHIVED` lifecycle contracts without persistence.
- Defined immutable Outreach Profile fields and input fingerprints without
  exposing placeholder production API values.
- Defined archive/restore and dependency-aware destructive-delete assessment
  contracts.
- Defined versioned Shared SEO Evidence snapshots with source authority,
  provenance, provider endpoint, fingerprint, market/language, and freshness.
- Added a read-only adapter that asks source modules for candidate evidence
  rather than reading colleague-owned internal tables directly.
- Defined immutable generation pins and rejects source-version substitution.
- Page refresh and polling do not dispatch paid evidence refresh calls.

## Migrations And Generated Contracts

- Platform migrations created or edited: `0`
- Backlinks SQL migrations created or edited: `0`
- Migrations executed: `0`
- OpenAPI files changed: `0`
- Generated clients changed: `0`
- Persisted lifecycle/Outreach Profile/shared-evidence state added: No

Static migration observations:

- Backlinks migration validation passes through `0060`.
- The repository Platform Alembic files continue through
  `20260814_0064_content_asset_provider_metadata.py`.
- `backend/database/deployment-manifest.v1.json` still declares Platform head
  `20260724_0007` and Backlinks head `0060`.
- The pre-existing frozen manifest test expects an older partial Backlinks file
  set and fails against the current manifest. This is not repaired in M1A.

## Three-Pass Audit

### Pass A: Ownership And Static Conflict

- Baseline branch, commit, and dirty state were inspected.
- Existing dirty documentation was not edited, reverted, staged, or deleted.
- No migration number, generated client, provider configuration, runtime
  startup, Gmail, AI, or recommendation-qualification file was claimed.
- No direct Backlinks dependency on colleague-owned internal repositories was
  introduced.
- `git diff --check` passes; Git reports only line-ending conversion warnings.
- Audit deviation: the owned-file list was not written to this result before
  edits. Formal acceptance therefore requires review/input.

### Pass B: Timeout, Retry, Idempotency, And External Effects

- No provider request was dispatched.
- No DataForSEO, Browser, AI, Gmail, OAuth, send, or sync action occurred.
- Shared-evidence reads are contract-only and read-only.
- Refresh and polling tests verify zero paid evidence refresh calls.
- External request identities: none.
- Actual product/provider cost: `$0`.
- Local package downloads were used only to repair the FastAPI test
  environment and were not product/provider calls.

### Pass C: Product, Runtime, And Evidence Classification

- Code/static evidence: implemented and focused checks pass.
- Contract evidence: implemented and focused tests pass.
- Local build evidence: frontend production build passes.
- Database runtime evidence: not proven; no working container runtime.
- FastAPI supported-runtime evidence: limited; tests passed under Python
  `3.12.13`, below the declared `>=3.13`.
- Real-provider evidence: not applicable and not executed.
- Gmail/AI evidence: not applicable and not executed.
- Human approval, deployment, and UAT evidence: not executed.

## Verification

### Frontend

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run test:project-authority-source` | PASS, 3/3 |
| `npx vitest run src/features/projects/project-context.test.tsx src/features/projects/project-switcher.test.ts` | PASS, 7/7 |
| `npx vitest run src/features/projects/create-project-dialog.test.tsx src/features/projects/business-profile-onboarding.test.tsx src/pages/module-page.test.tsx src/components/agent/agent-dock.test.tsx` | PASS, 64/64 |
| `npm run build` | PASS with existing dynamic-import and chunk-size advisories |

### Backlinks Core

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npx vitest run test/backlinks/api/shared-seo-evidence.test.ts` | PASS, 11/11 |
| `npm run source:manifest:check` | PASS, 28 records |
| `npm run migration:backlinks:check` | PASS, 52 files through `0060` |
| `npx vitest run test/unit/project-context-projection-governance.test.ts test/backlinks/api/project-context.test.ts test/unit/resource-library-authority.test.ts` | PASS, 15/15 |
| Integration attempt including `test/backlinks/integration/project-context-snapshot.test.ts` | Environment unavailable; 15 non-container tests passed and 2 container tests were skipped before assertions |

A broader Core API suite attempt produced 116 passes and 7 unrelated baseline
failures: six five-second timeouts and one existing private-server operation-ID
count mismatch (`73` expected, `74` actual). Those adjacent failures were not
modified under M1A.

### FastAPI

| Command | Result |
|---|---|
| Focused authority/contracts/projects/gateway pytest set | PASS, 44/44 |
| Project routes test file | PASS, 23/23 |
| Ruff `E4,E7,E9,F` on changed Python files | PASS |
| Ruff import checks on new/import-modified files | PASS |
| `python -m pytest tests/test_database_migration_system.py -q` | 6 PASS, 1 pre-existing frozen-manifest expectation FAIL |

The editable install failed because the repository currently exposes multiple
top-level packages to setuptools. Declared dependency ranges were installed
directly into the local `.venv` for focused testing; `pyproject.toml` and
`uv.lock` were not changed.

## Remaining Risks And Required Input

1. Decide whether to accept the owned-file prerecord deviation or require a
   clean, separately authorized rerun before marking M1A `PASS`.
2. M1B must add an additive, forward-compatible Workspace persistence and
   membership-assignment model before database-level
   Organization/Workspace/Project isolation can be claimed.
3. M1B must reconcile the stale Platform deployment-manifest head and its
   frozen partial-file test without editing applied migrations.
4. Re-run the container-backed Project-context integration tests with a working
   PostgreSQL/container runtime.
5. Re-run FastAPI evidence under the supported Python `>=3.13` toolchain.

## Stop Boundary

Coding stopped at M1A. No M1B persistence/migration work, M1C runtime work,
provider activation, recommendation change, AI draft work, Gmail work, merge,
commit, or push was started.

Next phase after explicit review and authorization:
`BACKLINKS-CORE-REMEDIATION-PHASE-M1B`.
