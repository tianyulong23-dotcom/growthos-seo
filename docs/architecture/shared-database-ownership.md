# Shared Database Ownership

> Date: 2026-07-24
> Status: `SEO4-INT-004` dual-migration repository contract accepted and
> verified through clean install, existing upgrade, and backup/restore in
> disposable PostgreSQL 18.4
> Production application: `UNKNOWN`

This document is the schema, role, migration, RLS, retention, and backup
ownership record required by the shared-repository architecture. The SQL and
tests prove the repository contract only. They do not prove that any local,
staging, or production database has applied it.

## Role Model

All declared database roles are hardened `NOLOGIN`, `NOSUPERUSER`,
`NOINHERIT`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and
`NOBYPASSRLS` privilege roles. Deployment login principals and credentials are
environment-owned and must not enter this repository.

| Schema | Owning module | Schema/migration owner | Business write role | Read role | RLS owner | Retention / backup owner |
|---|---|---|---|---|---|---|
| `platform` | Platform Context | `growthos_platform_owner` | `growthos_platform_writer` | Module contract only | `ROLE-PLATFORM-CONTEXT` | Module retention: `ROLE-PLATFORM-CONTEXT`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `crawling` | Crawler evidence | `growthos_crawling_owner` | `growthos_crawling_writer` | Audit contract and reporting projection only | `ROLE-CRAWLER` | Module retention: `ROLE-CRAWLER`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `audit` | Audit | `growthos_audit_owner` | `growthos_audit_writer` | Versioned projection only | `ROLE-AUDIT` | Module retention: `ROLE-AUDIT`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `keywords` | Keywords | `growthos_keywords_owner` | `growthos_keywords_writer` | Versioned projection only | `ROLE-KEYWORDS` | Module retention: `ROLE-KEYWORDS`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `content` | Content | `growthos_content_owner` | `growthos_content_writer` | Versioned projection only | `ROLE-CONTENT` | Module retention: `ROLE-CONTENT`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `backlinks` | Backlinks | `growthos_backlinks_owner` | `growthos_backlinks_writer` | `growthos_reporting_reader` | `ROLE-BACKLINKS` | Module retention: `ROLE-BACKLINKS`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |
| `reporting` | Reporting projections | `growthos_reporting_owner` | Projection owner only | `growthos_reporting_reader` | Projection owner | Projection retention: `ROLE-ARCHITECTURE`; cluster backup: `ROLE-PLATFORM-DATABASE-OPERATIONS` |

`growthos_gateway` has no schema, table, sequence, or function grant. It cannot
execute business SQL. The Platform Gateway must call module APIs.

The writer and reader roles do not own schemas and receive no `CREATE`
privilege. A deployment login principal may receive membership in exactly the
module privilege role it needs. Backlinks API and Worker connections use the
`backlinks,pg_catalog` search path and declare
`growthos_backlinks_writer` as their required privilege role.

The Platform, Crawling, and Audit writers use the hardened search paths
`platform,pg_catalog`, `crawling,platform,pg_catalog`, and
`audit,crawling,pg_catalog`. Crawling may read Platform Project facts but may
write only Crawling evidence. Audit may read Crawling evidence but may write
only Audit conclusions.

## Shared Bootstrap Ownership

`backend/database/roles/0001_growthos_schema_roles.sql` is owned by
`ROLE-PLATFORM-DATABASE-OPERATIONS` with mandatory review from
`ROLE-ARCHITECTURE` and every affected module owner. It creates only hardened
privilege roles and empty module schemas, revokes `PUBLIC`, and grants each
module writer `USAGE` on only its own schema.

The bootstrap contains no credentials, tables, RLS policies, business
migrations, or role memberships. Module migrations remain owned by their
modules.

## Alembic Migration Decision

The six source Alembic revisions are frozen byte-for-byte from
`origin/main@8261ea91a881948e3982a0eb96383c4c8bfa2523`. They remain a single
linear chain and initially stage their objects in `public`. The new
forward-only `20260724_0007_schema_ownership.py` bridge moves and secures the
objects without dropping or rebuilding them.

| Final schema | Tables | Migration authority |
|---|---|---|
| `platform` | `projects`, `site_profiles` | Alembic; final owner `growthos_platform_owner` |
| `crawling` | `crawl_runs`, `pages`, `page_snapshots`, `link_edges`, `backlink_checks`, `crawl_checkpoints`, `external_resources` | Alembic; final owner `growthos_crawling_owner` |
| `audit` | `audit_issues`, `pagespeed_results` | Alembic; final owner `growthos_audit_owner` |
| `backlinks` | 25 Backlinks tables | Backlinks SQL migrations only; final owner `growthos_backlinks_owner` |

All 11 Alembic-owned tables and all 25 Backlinks-owned tables have enabled and
forced RLS. Alembic may not stamp, drop, rename, rebuild, or grant ownership
over `backlinks` objects. Backlinks migrations may not change `platform`,
`crawling`, or `audit` objects.

## Backlinks Migration Decision

| Migration | Decision | Repository evidence |
|---|---|---|
| `0001_backlink_foundation.sql` | `KEEP` | SHA-256 `F355E3489103E3A6278D63843FAEBEF91F9E65E6D9DBEBADD678C907231276E2` |
| `0002_backlink_provider_seo.sql` | `KEEP` | SHA-256 `279406AE1E6ECA9D8FAAAD53C0AAD9FE13E5327F98C0B005EFDDF0BA2C9795E8` |
| `0003_backlink_recommendations.sql` | `KEEP` | SHA-256 `7DA2B77F8034ABF20F2576B3538657E87394C439D8C4BE9DF3E22B36A6199AD3` |
| `0004_backlink_contacts_opportunities.sql` | `KEEP` | SHA-256 `CDD2EEBA9A6FFAA68EBEF085666A7DF8225B645AE45CAA5DEDF7413FB218D4D7` |
| `0005_backlink_schema_role_ownership.sql` | `ADAPT` | Forward-only transaction moves the existing 21 tables and three functions to `backlinks`, transfers ownership, and applies grants/default privileges |
| `0006_backlink_opportunities.sql` | `ADD` | Creates Opportunity, Cycle, and Cooperation tables directly in `backlinks` as `growthos_backlinks_owner`; the existing Lifecycle table remains authoritative |
| `0007_backlink_opportunity_counter.sql` | `ADD` | Creates the Backlinks-owned project Counter and row-locked allocation function for continuous `join_sequence` values |

Published migrations `0001` through `0004` remain byte-for-byte unchanged.
No compatibility view, duplicate table, public alias, or rewritten migration
history is allowed.

Fresh installation order:

1. Apply the shared schema/role bootstrap with the controlled database
   migration principal.
2. Apply Backlinks migrations `0001` through `0004` in `public`.
3. Apply `0005` atomically.
4. Apply `0006` atomically.
5. Apply `0007` atomically.
6. Connect the Backlinks runtime through an environment login principal that
   is a member of `growthos_backlinks_writer`.

Existing installation order is the shared bootstrap followed by `0005` and
then `0006` and `0007`.
Before production execution, database operations must take and verify a
restorable backup and confirm that all 21 expected tables and three functions
exist in `public` before `0005`, then confirm all 25 tables and four functions
exist in `backlinks` after `0007`. A failed rollout is recovered by restore or a
reviewed forward migration, never by editing `0001` through `0004`.

## Backlinks Table Ownership

Every table below has schema `backlinks`, owning module Backlinks, write role
`growthos_backlinks_writer`, migration owner
`growthos_backlinks_owner`, and RLS policy owner `ROLE-BACKLINKS`.
Retention policy is owned by `ROLE-BACKLINKS`; physical backup and restore are
owned by `ROLE-PLATFORM-DATABASE-OPERATIONS`.

| Table | Source migration | Event or command source |
|---|---|---|
| `backlink_idempotency_records` | `0001` | Backlinks idempotent command handling |
| `backlink_outbox_events` | `0001` | Backlinks transaction and event publisher |
| `backlink_jobs` | `0001` | Backlinks commands and Workflows |
| `backlink_lifecycle_events` | `0001` | Backlinks lifecycle transitions |
| `backlink_audit_events` | `0001` | Backlinks commands and lifecycle audit |
| `backlink_project_context_snapshots` | `0001` | Backlinks consumption of Platform Project Context |
| `backlink_provider_requests` | `0002` | Backlinks provider adapter |
| `backlink_seo_snapshots` | `0002` | Backlinks provider response ingestion |
| `backlink_provider_cache_entries` | `0002` | Backlinks provider cache |
| `backlink_provider_budgets` | `0002` | Backlinks provider budget policy |
| `backlink_provider_usage_ledger` | `0002` | Backlinks provider cost reservation |
| `backlink_prospects` | `0003` | Backlinks recommendation inventory |
| `backlink_recommendations` | `0003` | Backlinks recommendation workflow |
| `backlink_recommendation_scores` | `0003` | Backlinks scoring workflow |
| `backlink_recommendation_inventory` | `0003` | Backlinks inventory refill |
| `backlink_recommendation_claims` | `0003` | Backlinks recommendation claims |
| `backlink_recommendation_rejections` | `0003` | Backlinks rejection command |
| `backlink_recommendation_refills` | `0003` | Backlinks refill command and Workflow |
| `backlink_contact_candidates` | `0004` | Backlinks contact discovery |
| `backlink_contact_evidence` | `0004` | Backlinks contact evidence ingestion |
| `backlink_contacts` | `0004` | Backlinks explicit confirmation command |
| `backlink_opportunities` | `0006` | Backlinks Opportunity commands |
| `backlink_opportunity_cycles` | `0006` | Backlinks repeated cooperation cycles |
| `backlink_opportunity_cooperation_types` | `0006` | Backlinks cooperation-method registry |
| `backlink_opportunity_project_counters` | `0007` | Backlinks Opportunity sequence allocation |

All 25 tables have enabled and forced RLS. The first 21 policies move with
their tables; `0006` and `0007` create four new tables and policies directly in
the owned schema. Future Backlinks tables must be created by
`growthos_backlinks_owner`; default privileges grant the Backlinks writer DML
and the reporting reader `SELECT` only.

## Combined Deployment Manifest

`backend/database/deployment-manifest.v1.json` is the executable ordering and
checksum authority. It records the PostgreSQL image digest, migration ID,
SHA-256, execution owner, final schema, prerequisites, order, and recovery
policy for the shared bootstrap, seven Alembic revisions, and seven Backlinks
migrations.

The current heads are Alembic `20260724_0007` and Backlinks `0007`. The
controlled order is:

1. Apply `shared-bootstrap-0001`.
2. Apply the Alembic chain through `20260724_0007`.
3. Apply Backlinks `0001` through `0007` in manifest order.
4. Verify ownership, role isolation, forced RLS, migration heads, and data
   preservation.
5. Recover by verified restore or a reviewed forward-only repair. Do not edit
   a released migration or reverse ownership in place.

## Permission Gate

The disposable PostgreSQL gate proves:

| Principal | Own-schema write | Cross-schema write | Approved read | DDL |
|---|---|---|---|---|
| `growthos_platform_writer` | `platform`, subject to RLS | Denied | `platform` | Denied |
| `growthos_crawling_writer` | `crawling`, subject to RLS | Denied | `platform`, `crawling` | Denied |
| `growthos_audit_writer` | `audit`, subject to RLS | Denied | `crawling`, `audit` | Denied |
| `growthos_backlinks_writer` | `backlinks`, subject to RLS/domain rules | Denied | `backlinks` | Denied |
| `growthos_gateway` | Denied | Denied | Denied | Denied |
| `growthos_reporting_reader` | Denied | Denied | Read-only projections | Denied |

`backend/database/tests/verify-postgresql18.ps1` applies the manifest contract
inside the pinned disposable
`postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296`
image, which reported PostgreSQL 18.4. It proves:

- clean bootstrap plus both migration heads;
- upgrade from the six source Alembic revisions and Backlinks `0001` through
  `0004`, preserving seeded Platform, Crawling, and Backlinks rows;
- custom-format `pg_dump` and `pg_restore` into a fresh database;
- exact schema/table ownership, 15 hardened roles, forced RLS, allowed writes,
  denied cross-schema writes, read-only reporting, and SQL-free Gateway access.

No local, staging, or production database is modified by this gate.

## Remaining Unknowns

- Named human/team assignments for all owner roles remain `UNKNOWN`.
- Deployment login-principal names and role memberships remain `UNKNOWN`.
- Application of this contract to local, staging, and production databases
  remains `UNKNOWN`.
- Repository-level disposable backup/restore evidence is `PROVEN`. Production
  backup schedule, retention periods, restore RTO/RPO, and environment-specific
  restore-drill evidence remain `UNKNOWN`; these block production rollout, not
  the repository ownership gate.
