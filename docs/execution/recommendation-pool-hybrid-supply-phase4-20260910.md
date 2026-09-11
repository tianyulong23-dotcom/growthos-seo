# Hybrid Supply Phase 4 - 2026-09-10

## Start Card

- Task: hybrid-supply-phase4-local-acceptance.
- Authority: recommendation-pool-hybrid-supply-coding-plan-20260910.md, Phase 4.
- Scope: focused regression, local UI/API acceptance, fixes for this change only.
- Stop: report evidence and remaining blockers; no Phase 5, commit, push, or production rollout.
- Baseline: main, HEAD 7df8d48d088328bd79fb0a1afef364b17cc8b6af,
  origin https://github.com/john3947/seo.git; 419 existing changed/untracked entries.
- Ownership: this report; narrowly required hybrid-supply tests or fixes after reading
  their current contents. All pre-existing and unrelated work is preserved.
- Provider ceiling: no real Gmail sends; no new paid DataForSEO discovery, AI requests,
  or bulk contact crawling. Reuse the independent Ahrefs authentication evidence;
  only the planned bounded project-DR application path may use the prepared new key.
- Data boundary: original publishers.sqlite is read-only, no full import or source edits.
- Verification: focused backend/API/integration tests, browser regression, original
  SQLite adapter timings, application credential/cache/match/publication path.
- Initial runtime: API 7200 responds; runtime reports maintenance and stale build,
  business consumers not running. Existing runtime is not evidence of the new code.

## Status

LOCAL_REGRESSION_PASS / REAL_APPLICATION_ACCEPTANCE_PARTIAL / NOT_DEPLOYED.

Phase 4 code hardening and focused local regression are complete. The full
uninterrupted real-provider-to-published-feed acceptance is NOT complete.
Do not interpret this report as activation in existing user projects.

## Changes Owned By Phase 4

- `scripts/dev-up.ps1`: forward the opt-in `RESOURCE_LIBRARY_SQLITE_PATH` and
  `AHREFS_CREDENTIAL_SECRET_REF` settings to the application; recognize migration
  heads 0099 and 0100. Preserve the script's pre-existing unrelated edits.
- `backend/core/src/modules/backlinks/db/migrations/0100_backlink_hybrid_batch_release.sql`:
  wrap the migration in BEGIN/COMMIT and use SET LOCAL role/search_path, preventing
  partial application when the normal psql startup path encounters an error.
- `backend/database/deployment-manifest.v1.json`: update the normalized-LF SHA256
  for 0100 to `cc0dc7eda81ce872f86560babcb9a227ea14f2da045010fb8db1e54610205ef9`.
- `backend/core/test/unit/recommendation-hybrid-supply-runtime.test.ts`: add startup
  configuration, migration-head recognition, and transaction-boundary assertions.
- `backend/core/test/backlinks/integration/recommendation-pool-v2-phase4-canonical-batch.test.ts`:
  add opt-in encrypted-secret/real-SQLite application acceptance and cache reuse
  checks, followed by publication and a 35-item feed query.
- `frontend/test/recommendation-feed-phase6.spec.ts` and
  `frontend/test/recommendation-feed-phase7.spec.ts`: align stale assertions with
  existing UI labels; assert initial limit=35, valid DR=0, and separate library
  monthly traffic versus natural-search ETV.

No production frontend layout or contact preparation behavior was changed in
this phase. No commit, push, main-database migration, or service restart occurred.

## Local Verification

Passing focused backend groups (distinct tests, not repeated run totals):

| Group | Result |
|---|---|
| Hybrid runtime/activity/finalization/allocation/supply, SQLite, feed and release API | 97 passed |
| PostgreSQL canonical batch, feed, and Opportunity bridge integration | 19 passed |
| Opportunity handoff/transitions and draft job/editing API | 12 passed |
| Contacts API and Temporal replay contract | 3 passed |
| Desktop/mobile Playwright, phase6 and phase7 specs | 8 passed |

The PostgreSQL acceptance test is opt-in. The 19-test integration run used
`HYBRID_SUPPLY_ACCEPTANCE=fixture`; ordinary runs skip that additional test.
A further focused run of the acceptance test passed after adding a pre-finalization
cache-hit assertion.

- Core TypeScript checking passed.
- Scoped backend and frontend ESLint passed.
- PowerShell parser accepted the updated startup script.
- Deployment manifest validation passed for 92 migrations through 0100.
- Temporary PostgreSQL integration databases applied the manifest, including 0100.
- Existing full-core lint failures documented in Phase 3 were not repaired or
  represented as passing here. Phase 3 contract evidence is reused; Phase 4 has
  no API contract changes.

The initial testcontainers startup timed out. Subsequent integration runs used
the existing external-admin harness against local PostgreSQL, which creates and
cleans isolated random test databases. They did not migrate the main business DB.

Browser tests use mocked API responses and exercise actual frontend code.
They cover publication readiness, filtering, sorting, pagination, export,
Opportunity creation, archive/undo, and exhausted supply without provider calls.
Desktop and mobile screenshots were inspected: DR=0 and library traffic 12,345
are visible, missing natural-search metrics remain unavailable, and the tested
layouts have no horizontal overflow.

Screenshot artifacts:

- `frontend/output/playwright/results/recommendation-feed-phase7-2321e-bile-without-provider-edges-desktop-chromium/recommendation-feed-phase7-desktop-chromium.png`
- `frontend/output/playwright/results/recommendation-feed-phase7-2321e-bile-without-provider-edges-mobile-chromium/recommendation-feed-phase7-mobile-chromium.png`

## Real Library Evidence

The existing read-only adapter queried the original `publishers.sqlite`:
49,742 rows and 49,737 distinct domains. The performance input used project DR=61
as a fixture, not as a claim about the value returned by this phase's live request.

| Query limit | Selected / unique | DR >= 60 | Elapsed |
|---|---|---|---|
| 100 | 100 / 100 | 40 | 222.35 ms |
| 1000 | 1000 / 1000 | 400 | 199.69 ms |

These are individual local measurements, not a production latency guarantee.
Source-file SHA256 was unchanged before and after. No full import, source
mutation, or cross-project copy of the library was performed.

## Application Path And External Calls

The prepared new DPAPI credential was imported through the existing application
credential-import CLI into the encrypted secret store:

- Store: `C:\Users\DELL\AppData\Local\GrowthOS\live001\secrets`
- Reference: `secret://growthos/local-product/ahrefs/provider-credential/v1`

The import itself made no provider request. No key contents were logged or
written to this report, and the actual deployment environment was not edited.

One bounded real application verification was performed, without another
standalone authentication preflight:

1. Production runtime read the imported encrypted credential.
2. Project DR retrieval and persistence succeeded in an isolated test database.
3. Real SQLite matching and canonical generation finalization succeeded.
4. The attempted publication fixture failed with
   `AVAILABLE batch requires complete canonical items and terminal contacts.`

That failure was a missing contact terminal state in the test fixture, correctly
rejected by the database guard. It was not evidence of a production contact
pipeline defect. The exact returned DR and HTTP-attempt count were not retained
in visible output. This was one bounded adapter invocation, permitting at most
three GET attempts; do not claim an exact count of one HTTP request.

The fixture was then corrected and the complete local chain passed using a
mocked Ahrefs response, the real encrypted store, the real SQLite adapter, and
isolated PostgreSQL. This included cache reuse without another HTTP request,
canonical publication, and an actual feed query returning 35 items with library
DR and no invented DataForSEO rank.

Contact completion in this integration test is explicitly fixture state
(`NO_CONTACT_FOUND` and terminal timestamps), not a real crawl. Test-only
updates were confined to the isolated database; no main business state was
manually changed. The corrected run did not repeat the real Ahrefs call.

Consequently these are two evidence layers, not one successful uninterrupted
real-provider end-to-end run.

External actions in this phase:

- Ahrefs: one bounded real application verification as described above.
- Paid DataForSEO discovery: none.
- AI requests: none.
- Bulk contact crawling: none.
- Gmail sends: none.

## Runtime Boundary And Remaining Acceptance

The existing API on port 7200 reported maintenance/stale build and no running
business consumers. Its main database did not yet have the new project-DR table
or hybrid snapshot column. The opt-in library path and Ahrefs reference were
not configured in its deployment environment. Therefore a user refreshing the
existing application is not proof that the new supply behavior is active.

Three existing waiting-provider jobs were observed. Starting normal consumers
could resume unrelated paid work; this phase did not restart them merely to
produce a green runtime status. There were no pending send intents in the
read-only snapshot, but that does not authorize real sending or paid discovery.

Remaining work before claiming full real-project acceptance:

1. Apply the new migrations and explicit opt-in settings in a controlled local
   activation, with unrelated provider jobs prevented from resuming.
2. Complete one uninterrupted application publication/GET acceptance with the
   real provider result or its valid persisted cache and the existing contact
   preparation path. The temporary database from the partial live run was
   cleaned up, so its cache is not available in the main user project.
3. Verify the newly activated UI/API on the intended user project. Human
   acceptance, production deployment, and commercial data-license confirmation
   remain separate from these test results.

No new phase is invented for these items: they are explicit limits on the
Phase 4 acceptance claim. The current delivery is locally tested code and
partial real-provider evidence, not a fully activated or fully accepted rollout.
