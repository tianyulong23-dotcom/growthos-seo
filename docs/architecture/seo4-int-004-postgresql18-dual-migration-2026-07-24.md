# SEO4-INT-004 PostgreSQL 18 Dual-Migration Report

> Date: 2026-07-24
> Status: `DONE`
> Evidence scope: repository and disposable PostgreSQL 18.4 only
> Production application: `UNKNOWN`

## Authority And Scope

`SEO4-INT-004` integrates the frozen Platform/Audit/Crawler Alembic history
with the existing Backlinks SQL migration history. It does not rewrite either
published chain, run against a persistent environment, adapt the Go Worker, or
execute `SEO4-INT-006`.

The six source Alembic revisions were imported byte-for-byte from
`origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`. Backlinks migrations
`0001` through `0007` retain their existing SHA-256 values. A new forward-only
Alembic bridge, `20260724_0007_schema_ownership.py`, is the only ownership
adaptation.

## Final Ownership

| Schema | Tables | Writer | Migration authority |
|---|---:|---|---|
| `platform` | 2 | `growthos_platform_writer` | Alembic |
| `crawling` | 7 | `growthos_crawling_writer` | Alembic |
| `audit` | 2 | `growthos_audit_writer` | Alembic |
| `backlinks` | 25 | `growthos_backlinks_writer` | Backlinks SQL |

All 36 business tables have enabled and forced RLS. Platform, Crawling, Audit,
and Backlinks each have one table owner and one writer boundary. The Gateway
has no SQL grants. The reporting role is read-only.

Alembic may not stamp, drop, rename, rebuild, or grant ownership over
`backlinks`. Backlinks migrations may not mutate `platform`, `crawling`, or
`audit`.

## Deployment Contract

`backend/database/deployment-manifest.v1.json` pins:

- PostgreSQL major `18` and the exact `postgres:18-bookworm` image digest;
- Alembic head `20260724_0007`;
- Backlinks head `0007`;
- every bootstrap and migration path, SHA-256, execution owner, final schema,
  prerequisite, order, and recovery instruction;
- recovery policy `restore-or-forward-only`.

The shared bootstrap owns roles and schemas only. Alembic owns Platform,
Crawling, and Audit tables. Backlinks SQL owns Backlinks tables. No two tools
own the same business schema.

## Test-First Evidence

The initial static gate failed four tests because the source Alembic revisions,
the Crawling role/schema, and the deployment manifest were absent. After the
implementation, all four static migration-system tests passed.

`backend/database/tests/verify-postgresql18.ps1` then completed these
disposable checks against PostgreSQL 18.4:

1. Clean install: bootstrap, Alembic head, Backlinks `0001` through `0007`,
   ownership/RLS/permission contract.
2. Existing upgrade: source Alembic head `20260722_0006`, Backlinks `0001`
   through `0004`, seeded legacy Platform/Crawling/Backlinks rows, then both
   ownership bridges and remaining migrations.
3. Data preservation: all seeded legacy rows remained present in their final
   owned schemas.
4. Backup/restore: custom-format `pg_dump`, fresh database, `pg_restore`, then
   the full ownership/RLS/permission contract again.
5. Cleanup: no labeled test container or Docker network remained.

The role contract also proved permitted own-schema writes, denied
cross-schema writes, tenant/project RLS, read-only reporting, SQL-free Gateway
access, 15 hardened roles, and hardened search paths.

The Backlinks aggregate regression passed typecheck, lint, source/dependency
and license gates, OpenAPI, migration checks, Unit 78/78, API 48/48, Contract
49/49, Integration 71 executed with 13 environment-gated skips, and Security
88/88. Its final aggregate command returns 1 because the repository has no
`test/resilience` files; the existing explicit
`--passWithNoTests` Resilience allowance returned 0. This task did not modify
the Backlinks package script.

## Evidence Classification

| Finding | Status |
|---|---|
| Frozen Alembic source matches the selected coworker commit | `PROVEN` |
| Backlinks `0001` through `0007` remain unchanged | `PROVEN` |
| PostgreSQL 18.4 clean install, upgrade, data preservation, and restore | `PROVEN` |
| One migration owner per Platform/Crawling/Audit/Backlinks schema | `PROVEN` |
| Production login principals, role memberships, and secrets | `UNKNOWN` |
| Local, staging, or production application of this migration system | `UNKNOWN` |
| Production backup schedule, RTO/RPO, and approved restore drill | `UNKNOWN` |
| Authenticated human approval from Database Operations and Crawler owners | `UNKNOWN` |

## Stop Condition

`SEO4-INT-004 = DONE`. `SEO-V4-CRAWLER-GATE` remains pending because the
executable Go Worker still requires `SEO4-INT-006`. `BL-AI-081` remains
blocked. No frontend synchronization, paid Provider call, supplied credential
use, persistent database operation, Git commit, or Git push occurred.
