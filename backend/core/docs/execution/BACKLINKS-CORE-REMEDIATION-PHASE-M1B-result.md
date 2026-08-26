# BACKLINKS-CORE-REMEDIATION-PHASE-M1B Result

Status: `PASS`

Date: `2026-08-15`

Task: `BACKLINKS-CORE-REMEDIATION-PHASE-M1B`

Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo-main`

## Authorized Scope And Stop Boundary

Implement additive persistence for the M1A Project lifecycle, immutable
Outreach Profile, Shared SEO Evidence references, and generation input pins.
Repair the deployable Platform and Backlinks migration graphs while preserving
the frozen legacy revisions.

Stop after M1B verification. Do not start M1C, change Core runtime activation,
call DataForSEO or another provider, invoke paid AI, authorize or send Gmail,
merge, commit, or push.

## Baseline

| Item | Value |
|---|---|
| Branch | `main` |
| Baseline commit | `2092d0da79cf8b126421369a9ca9db7fd4acd503` |
| Platform head before M1B | `20260814_0064` |
| Backlinks head before M1B | `0060` |
| Provider/Gmail paid-call ceiling | `0` |

## Pre-Registered Owned Files

Only the following files are owned by M1B. A listed file may remain unchanged
if implementation proves it unnecessary.

### Platform Project Persistence

- `backend/api/app/modules/projects/models.py`
- `backend/api/app/modules/projects/schemas.py`
- `backend/api/app/modules/projects/service.py`
- `backend/api/app/modules/projects/authority.py`
- `backend/api/app/api/routes/projects.py`
- `backend/api/app/core/authoritative_platform_context.py`
- `backend/api/tests/test_projects.py`
- `backend/api/tests/test_project_authority.py`
- `backend/api/tests/test_authoritative_platform_context.py`
- `backend/api/tests/test_project_contracts.py`
- `backend/api/tests/test_shared_contracts.py`

### Platform Migration Graph And Contract

- `backend/api/migrations/versions/20260805_0008_website_project_authority.py`
- `backend/api/migrations/versions/20260806_0009_backlinks_project_scope_authority.py`
- `backend/api/migrations/versions/20260813_0010_website_project_audiences_goals.py`
- `backend/api/migrations/versions/20260815_0065_backlinks_project_persistence_merge.py`
- `backend/api/tests/test_database_migration_system.py`
- `backend/database/deployment-manifest.v1.json`
- `backend/contracts/openapi/platform.v1.json`

### Backlinks Persistence

- `backend/core/src/modules/backlinks/ports/shared-seo-evidence.port.ts`
- `backend/core/src/modules/backlinks/db/migrations/0044_backlink_platform_project_authority.sql`
- `backend/core/src/modules/backlinks/db/migrations/0061_backlink_project_input_persistence.sql`
- `backend/core/src/modules/backlinks/db/repositories/project-input-persistence.repository.ts`
- `backend/core/scripts/check-backlinks-migrations.ts`
- `backend/core/test/backlinks/api/shared-seo-evidence.test.ts`
- `backend/core/test/backlinks/integration/project-input-persistence-migration.test.ts`
- `backend/core/test/unit/project-input-persistence.repository.test.ts`

### Frontend Lifecycle Mapping

- `frontend/src/api/projects.ts`
- `frontend/src/app/app-shell.tsx`
- `frontend/src/features/projects/types.ts`
- `frontend/src/features/projects/project-context.tsx`
- `frontend/src/features/projects/project-context.test.tsx`
- `frontend/src/pages/projects-page.tsx`

### Result

- `backend/core/docs/execution/BACKLINKS-CORE-REMEDIATION-PHASE-M1B-result.md`

## Planned Verification

- actual Alembic graph has one current head and includes frozen
  `20260805_0008`, `20260806_0009`, and `20260813_0010`;
- actual Backlinks graph and manifest include frozen `0044` and current `0061`;
- lifecycle/archive/restore, immutable versions, dependency guards, and exact
  Workspace/Project authority pass focused tests;
- Platform OpenAPI and frontend mappings expose only persisted backend state;
- migration and persistence tests make zero provider, AI, OAuth, Gmail, or
  send calls.

## Implementation Result

- Project lifecycle state is persisted as `ACTIVE` or `ARCHIVED`, with
  optimistic lifecycle versions, archive reasons, archive/restore routes, and
  exact Organization/Workspace/Project authority.
- Project deletion fails closed when retained Backlinks, Gmail, Reply,
  Placement, monitoring, inventory, or report dependencies exist.
- Outreach Profile versions, Shared SEO Evidence references, and generation
  input pins are immutable tenant-scoped Backlinks records protected by RLS,
  unique version/fingerprint constraints, and update/delete rejection triggers.
- Frozen Platform revisions `0008`, `0009`, and `0010`, plus frozen Backlinks
  revision `0044`, retain their fixed checksums. The current heads are
  Platform `20260815_0065` and Backlinks `0061`.
- The deployment manifest covers the complete current Platform and Backlinks
  migration graphs. Platform OpenAPI and frontend project state map the
  persisted lifecycle fields.
- The Alembic migration connection resolves `public`, `platform`, `crawling`,
  and `audit`, so a frozen Website Project `0010` database can apply the other
  migration branch without modifying historical revisions.

## Verification Evidence

| Evidence | Result |
|---|---|
| Platform focused pytest | `58 passed` |
| Platform Python compile | `PASS` |
| Alembic graph | `20260815_0065 (head)` |
| Shared contract drift check | `PASS`, 230 paths / 260 operations |
| PostgreSQL engine | `18.4`, Docker Engine `29.6.2`, API `1.55` |
| Fresh PostgreSQL 18 install | `PASS`, Platform `0065` / Backlinks `0061` |
| Immutable inputs after database restart | `PASS` |
| Legacy Platform `0010` / Backlinks `0044` upgrade | `PASS` |
| Upgraded database backup and restore | `PASS` |
| Disposable Docker resource cleanup | `PASS` |
| Core TypeScript typecheck | `PASS` |
| Core focused Vitest | `13 passed` |
| Backlinks migration graph | `PASS`, 54 files through `0061` |
| Frontend TypeScript typecheck | `PASS` |
| Frontend project-context Vitest | `6 passed` |
| Git whitespace check | `PASS` |
| Provider/AI/OAuth/Gmail/send calls | `0` |

Evidence classification:

- `CODE_CONTRACT`: `PASS`
- `STATIC_MIGRATION_GRAPH`: `PASS`
- `RUNTIME_POSTGRESQL18_APPLY`: `PASS`
- `REAL_PROVIDER`: `NOT_RUN`
- `GMAIL_SEND`: `NOT_RUN`

## Runtime Verification Result

Docker Desktop was restarted through its bounded CLI, restoring the local Linux
Engine without a global WSL reset. A disposable PostgreSQL `18.4` container and
Python `3.13.11` verification container then proved the fresh graph, legacy
upgrade, restart persistence, and backup/restore paths. All disposable
containers, networks, and volumes were removed after the run.

## Runtime Verification Continuation

Continuation authorized by the user's `继续下一步` instruction on
`2026-08-15`.

- Scope: complete only the missing M1B PostgreSQL 18 fresh-install,
  legacy-upgrade, and backup/restore evidence.
- External-action ceiling: `0` provider requests, `0` paid AI calls,
  `0` Gmail authorization/send/sync actions.
- Repository edit ceiling: the existing M1B-owned files only, and only if
  runtime verification reproduces an M1B defect.
- Stop point: finalize M1B and stop. M1C remains blocked until M1B is `PASS`.
- Commit/push permission: none.

### Runtime-Reproduced Scope Amendment

The PostgreSQL 18 legacy upgrade reproduced a migration-environment defect:
after frozen revision `20260724_0007` moves `crawl_runs` to `crawling`, the
other Alembic branch cannot resolve its unqualified foreign key while upgrading
through `20260724_0009`.

- Added repair file: `backend/api/migrations/env.py`.
- Repair ceiling: extend only the migration connection `search_path`; do not
  modify any frozen or historical migration.
- Added regression coverage only in the already-owned
  `backend/api/tests/test_database_migration_system.py`.

## Stop Point

M1B is `PASS` and stopped. M1C was not started. No product runtime activation,
provider call, Gmail action, merge, commit, or push was performed.
