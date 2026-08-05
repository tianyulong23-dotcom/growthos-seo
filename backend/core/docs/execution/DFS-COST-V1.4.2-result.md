# DFS-COST V1.4.2 Result

Status: PASS_DEVELOPMENT_ONLY
Date: 2026-07-30
Scope: DFS-COST-001 through DFS-COST-006 and DFS-COST-GATE

## Result

| Task | Status | Implemented behavior |
| --- | --- | --- |
| `DFS-COST-001` | INTEGRATED | Added cost-baseline queries, stable metrics, explicit Request Intent, refresh mode, and authorization checks. Public fingerprints contain only normalized Provider-changing parameters. |
| `DFS-COST-002` | INTEGRATED | Added Discovery, Card Enrichment, Deep Assessment, and Monitoring intent gates so expensive evidence is fetched progressively instead of by default. |
| `DFS-COST-003` | INTEGRATED | Added global Provider Batch and Artifact storage plus tenant-scoped Workspace Evidence Projection and Artifact Usage records. Public Artifacts contain no Organization, Workspace, or Project identity. |
| `DFS-COST-004` | INTEGRATED | Added global lease-based single-flight, bounded follower wait, heartbeat, expiry takeover, and fail-closed unknown-charge reconciliation. |
| `DFS-COST-005` | INTEGRATED | Added Workspace-local Card Enrichment Bulk execution with exact actual-cost allocation, partial success, negative-result persistence, and retry of temporary item failures only. |
| `DFS-COST-006` | INTEGRATED | Added intent-specific freshness, shorter negative-cache windows, stale-while-revalidate outcomes, and adaptive recommendation inventory decisions. |
| `DFS-COST-GATE` | PASS_DEVELOPMENT_ONLY | Full Core and PostgreSQL 18.4 verification passed. No real Provider or production Canary was authorized or executed. |

## Integration

- The established project-analysis Activity now declares `DISCOVERY`,
  `BACKGROUND_REFRESH`, locale, response schema, and usage purpose.
- The established Provider Analysis Repository now uses the cost-control
  coordinator instead of the former Workspace-local cache coordinator.
- Existing `backlink_provider_budgets`,
  `backlink_provider_usage_ledger`, and
  `backlink_reserve_provider_cost` remain the budget authority.
- Batch start writes the cost-control batch and legacy budget request in one
  transaction. Success atomically writes or updates the public Artifact,
  Workspace Projection, Usage allocation, budget settlement, and lease
  completion.
- Known pre-dispatch failures release reserved budget. Unknown-charge outcomes
  retain the reservation and block lease reacquisition until reconciliation.
- Forward-only Migration `0032_dataforseo_cost_control.sql` adds Batch,
  Artifact, Projection, Usage, and Lease storage with forced RLS and restricted
  role access.

## Verification

| Check | Result |
| --- | --- |
| Focused cost-control Unit | 8/8 passed |
| Focused cost-control PostgreSQL Integration | 6/6 passed |
| Established project-analysis workflow Integration | 3/3 passed |
| Full Core Gate | `npm run verify:backlinks` exited 0 |
| TypeScript and ESLint | PASS |
| Source, dependency, and license governance | 26 source records, allowlist PASS, 642 packages PASS |
| Backlinks OpenAPI | 45 paths PASS |
| Migration checker | 25 files through `0032` PASS |
| Unit | 71 files, 397 tests passed |
| API | 30 files, 86 tests passed |
| Contract | 20 files, 144 tests passed |
| Integration | 47 files, 171 tests passed; 4 files and 13 tests explicitly skipped |
| Security | 9 files, 102 tests passed |
| Resilience | 3 files, 8 tests passed |
| PostgreSQL 18.4 | Clean install, historical upgrade and DataForSEO write compatibility, backup, and restore PASS |
| Migration SHA-256 | `66dd40d4120b8899fb1eaac8e40f1166f10f79a902461772395841bf8d7d656c` |
| Residual Docker resources | None |

## Boundaries

- No real DataForSEO request or paid Provider call was made.
- No production database, credential, or production resource was used.
- No production or authenticated product E2E claim is made.
- `FORCE_LIVE` still requires explicit budget and frequency authorization.
- No Git commit or push was performed.
