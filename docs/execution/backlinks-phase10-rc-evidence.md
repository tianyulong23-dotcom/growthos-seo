# Backlinks Phase 10 Release Candidate Evidence

- Task: `BL-AI-197`
- Date: `2026-07-30`
- Result: `PASS_DEVELOPMENT_ONLY`
- Preconditions: `BL-AI-180..196 = DONE`
- Git HEAD: `8e056945975093c2c720e944fca6666c2638ece3`

## Verification

| Area | Command or proof | Result |
| --- | --- | --- |
| Core | `npm run verify:backlinks` | PASS: typecheck, ESLint, source manifest 26, dependency allowlist, 642-package license inventory, Backlinks OpenAPI 45 paths, 25 migrations through `0032`, Unit 71 files/397 tests, API 30/86, Contract 20/144, Integration 47 passed files plus 4 skipped with 171 passed and 13 skipped tests, Security 9/102, Resilience 3/8 |
| Production dependencies | `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| Supply chain | focused Vitest plus deterministic SBOM rebuild | PASS: 4 files/22 tests; CycloneDX 1.7 contains 629 exact components and 0 sensitive fields; SBOM, NOTICE, lockfile, and source-manifest hashes were unchanged |
| FastAPI | locked Python 3.13/uv container: Ruff, Pytest, shared contract checker | PASS: Ruff clean; 34 passed, 1 skipped; aggregate OpenAPI 67 paths/72 operations, 1 cross-module command, 1 cross-module event, 4 module Task Queues |
| Shared runtime | `backend/api/scripts/check_shared_runtime_isolation.ps1` | PASS after replacing the stale 7-route assertion with the frozen 45-route count; command count 1; health/audit stayed 200 after Core stop; Backlinks returned 503 |
| PostgreSQL 18 | `backend/database/tests/verify-postgresql18.ps1` | PASS on PostgreSQL 18.4: clean install, historical upgrade through `0032`, DataForSEO write compatibility, backup/restore, contracts, and RLS; 68 table counts and 3 facts matched; RPO 0.255s, RTO 49.907s |
| Shared Crawler | pinned Go 1.25.4 image at digest `698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d` | PASS: `go test ./...`, `go test -race ./...`, and `go vet ./...`; Browser disabled |
| Frontend | Outreach source tests, typecheck, ESLint, Vite build | PASS: 40/40 tests; Vite 8.1.5 transformed 2310 modules |
| UI E2E | desktop, mobile, keyboard/a11y Playwright suites, serial with one worker | PASS: 1/1 each using local Chromium and intercepted local APIs; no non-local provider traffic |
| Rollback and Kill Switch | focused provider/send/Browser/Worker drill | PASS: 5 files/30 tests |
| Repository and cleanup | `git diff --check`, process/port/Docker/default-off audits | PASS: HEAD unchanged; current-task container/network residuals 0; product Browser/Crawler processes 0; Playwright port listeners 0 |

## Release Constraints

- `DATAFORSEO_ENABLED`, `GMAIL_ENABLED`, `GMAIL_SEND_ENABLED`, `GMAIL_SYNC_ENABLED`,
  `GMAIL_PUSH_ENABLED`, `CRAWLER_BROWSER_ENABLED`, and `BACKLINKS_WORKER_ENABLED`
  were not enabled.
- No real Gmail, Pub/Sub, DataForSEO, AI, Browser/provider, or production database
  call was made.
- Local Playwright Chromium was test tooling only and exited after every suite.
- The existing empty Docker network owned by `BL-AI-CC-003` was not changed.
- No commit or push was performed.
- This result is development-only evidence. Real-provider or production release
  authorization remains a separate explicit decision.
