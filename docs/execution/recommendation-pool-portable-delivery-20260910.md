# Portable Recommendation Pool Delivery

## Scope

- Authority: user request on 2026-09-10 to deliver recommendation-pool code and
  resource-library data together through the repository.
- Baseline: main, HEAD 7df8d48d088328bd79fb0a1afef364b17cc8b6af; origin
  https://github.com/john3947/seo.git. Existing dirty work is preserved.
- Ownership: bundled publisher data, export/check tooling, runtime resource
  location, startup settings, focused tests, and colleague setup documentation.
- Stop: local portability verification and handoff. No commit/push, main
  database migration, service restart, or provider calls.
- Data: export the complete publisher table using an explicit column allowlist;
  exclude source import metadata, local paths, credentials, and business DBs.
- Success: bundled rows match the source, relocated checkout can read and match
  the bundle without the source path, normal builds verify the asset, and setup
  describes all required application components and personal credentials.

## Status

IMPLEMENTED / TESTED. No commit/push or colleague-machine deployment performed.

## Delivery

- Exported all 49,742 publisher rows and all 16 catalog columns into
  `backend/core/resources/resource-library/bundled/publishers.sqlite`.
  The original import-metadata table and unknown extra columns are excluded.
- Snapshot size: 9,342,976 bytes. Distinct domains: 49,737.
- File SHA256: `b33597e185be10ab528562cdf2ec3e99188869b6b1fc49d68e686e22c45313ce`.
- Full ordered row-content SHA256:
  `ceb757658444339334575435bb5eef5f924b6d866bc683e387ebb10ed1feb1b7`.
  The exporter compared this against the read-only source before accepting output.
- Added deterministic export/check tooling and a manifest. Normal Core builds
  validate the bundled asset; build identity includes the database and manifest.
  Git attributes explicitly preserve SQLite as binary and manifest as LF text.
- Runtime defaults to the bundled path relative to the Core module root, for both
  src and dist layouts. External absolute or Core-relative paths still work.
  Explicit `RESOURCE_LIBRARY_ENABLED=false` disables the library branch.
  Invalid explicit paths fail closed instead of switching catalogs silently.
- Default Ahrefs secret reference matches the existing import helper; no personal
  absolute path is needed in the repository.
- Added first-install `team:credentials:init`: validates all input, uses the
  existing encrypted store for Ahrefs/DataForSEO/Google/AI, writes managed AI
  settings, requires a fresh destination, and does not use an old live manifest.
  It does not authorize a mailbox or make network requests.
- Added settings examples, README entry and complete team handoff documentation
  at `docs/recommendation-pool-team-setup.md`.

## Ownership

Task-owned changes are the bundled data/manifest/README, `.gitattributes`,
`scripts/dev-up.ps1` resource flag forwarding, `deploy/compose/.env.example`,
Core package scripts, `resource-library-bundle.mjs`,
`bootstrap-team-credentials.ts`, `local-product-build-identity.ts`,
`resource-library-location.ts`, `recommendation-hybrid-supply-runtime.ts`,
their focused tests, the root README, setup guide, and this result.

Existing recommendation/Opportunity/contact/draft/send implementations, API
contracts, migrations and generated clients remain in this checkout. They must
be reviewed and included together in the eventual Git commit; this task did not
stage or silently commit the large pre-existing dirty worktree.

## Verification

- 9 focused unit/runtime suites: 96 tests passed, covering portability, all four
  fresh credential imports/resolution contexts, startup wiring, data integrity,
  full catalog counts, relative/absolute overrides, read-only matching, batch
  allocation, hybrid finalization and build fingerprint invalidation.
- Canonical PostgreSQL integration: 9 tests passed. The opt-in acceptance used
  `HYBRID_SUPPLY_ACCEPTANCE=fixture`, blank library path and blank Ahrefs reference,
  exercising both defaults. It used the bundled real SQLite, encrypted credential
  resolution, mocked Ahrefs HTTP, temporary PostgreSQL, cache reuse, canonical
  publication and 35-item feed query. Contact terminal state remained a fixture.
  Existing local encrypted credentials were resolved but never printed or sent.
- Core build passed, including asset verification and TypeScript compilation.
- Scoped ESLint passed; updated PowerShell startup script parsed successfully.
- Relocated compiled path resolver and copied asset into a temporary Core layout,
  then matched 1,000 rows with the compiled adapter: PASS, zero provider calls.
  This checks module/asset relocation, not a fresh network dependency install.
- Unit relocation also matched 1,000 unique domains with 400 high-DR rows and
  verified unchanged database digest.
- A native `fs.cpSync` directory-copy probe exited unexpectedly on this machine.
  The portability fixture now copies its two known asset files with `copyFileSync`;
  the subsequent full focused run passed without worker errors.
- `git check-ignore` confirmed the bundled database, manifest and new runtime/
  initialization files are not excluded. They are still uncommitted files, not
  proof of publication to GitHub.

## Boundaries

- No real provider requests, paid discovery, AI calls, Gmail authorization or sends.
- No main business database migration, business-state edits or service restart.
- Source catalog opened read-only; no full business database or private account
  data exported. Full publisher data is bundled, not pre-admitted into every project.
- No commit or push; no remote upload or repository visibility change.
- The existing startup entry remains Windows-oriented. A portable catalog does
  not establish Linux full-stack deployment acceptance.
- Teammates must install dependencies, configure their credentials and services,
  run migrations and complete their own Gmail authorization. They do not need
  the author's external catalog path, DPAPI intake or historical runtime directory.
- Colleague-machine fresh-clone installation and real-provider full-project UAT
  have not been performed. Prior Phase 4 real-project activation limits remain;
  this task solves code/data handoff, not that separate runtime acceptance.
- Confirm data redistribution permissions before a public repository release.
