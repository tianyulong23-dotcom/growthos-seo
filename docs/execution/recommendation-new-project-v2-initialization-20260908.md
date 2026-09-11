# New-project V2 initialization repair

Date: 2026-09-08

## Scope and ownership

Shared new-project initialization and recommendation reads, not a project-specific
database patch. Repository: john3947-seo-main, main, baseline HEAD
7df8d48d088328bd79fb0a1afef364b17cc8b6af. The worktree contained substantial
pre-existing changes; none were reverted. This supplements the entry-gate repair
in recommendation-new-project-entry-20260908.md, not whole Gate 10 acceptance.

## Root causes and production changes

1. Project context projection still scheduled a V1 project-analysis job/outbox
   event after writing the V2 input and project contract. The real database freeze
   rejected it with `V1 recommendation outbox is frozen.`, rolling back the entire
   transaction. Removed legacy scheduling from the shared projection command.
   Snapshot, V2 input pins, governance and V2_READY contract now commit atomically.
   Replays remain idempotent. Generation still requires an explicit user command.
2. Read repositories rejected a correctly initialized V2_READY project with no
   generation. User-release status now represents it as NOT_PUBLISHED; the feed
   returns an empty result with latestGeneration null. OpenAPI and the generated
   frontend client agree. Blocked migrations and invalid write bindings are still
   rejected, and old cursors cannot silently bind to an ungenerated project.
3. The frontend now displays the ungenerated state rather than indefinite loading,
   and does not display a misleading preparation/unlock progress bar before any
   generation exists.

## Regression evidence

- Before repair: isolated PostgreSQL integration reproduced the real V1 freeze
  rollback; existing unit expectations exposed legacy job scheduling.
- After the first repair: the same real-DB test reproduced the separate V2_READY
  read conflict. Regression coverage now checks both successful empty reads and
  continued rejection of blocked or incomplete generation inputs.
- Core: 8 test files, 29 tests passed. Includes projection governance, real-DB
  projection demand, V1 retirement, feed repository/query/routes, and user-release
  command/routes.
- Frontend: 3 files, 29 tests passed (entry setup, workspace, feed API).
- Platform: 17 tests passed (promotion confirmation, project contracts, readiness).
- Core build and frontend typecheck passed.
- OpenAPI check: 87 paths. Generated client check: 89 operations.
- git diff --check passed; pre-existing LF/CRLF warnings remain.

## Local runtime acceptance

Core API and worker build: `local-product-6714a915e661415bdf281bbc`.
Gateway runtime status reports the matching current build and healthy projection
delivery, with no pending, permanent-failed or exhausted projection events.

The existing confirmed event `cbd3618c-d2ed-4490-b2bd-68654dc1eae3` was replayed
through the production ProjectContextProjectionDispatcher, not SQL writes.
It published successfully at 2026-09-08T08:57:03.774263Z on attempt 9.
Project `7e1c7515-b9b3-4247-80ed-12b3eecee3a2` (elephtvza.com) now has snapshot
version 3 and a V2_READY contract, with no generation launched.

Browser verification on localhost:5173:

- Original project's feed and user-release status return HTTP 200.
- Normal ungenerated workspace is visible; the backend-disconnected alert is gone.
- Desktop 1440x1000 has no document horizontal overflow.
- Screenshot: .playwright-cli/new-project-v2-ready-20260908.png.
- Existing Snapmaker project still returns 16 recommendations and PUBLISHED status,
  both HTTP 200.
- An unrelated existing agent/conversations 404 remains in the sidebar. This repair
  does not claim that separate assistant feature is fixed.

## Safety and remaining acceptance boundaries

Provider ledger stayed at 273 rows. No new paid discovery, generation, or Gmail
send was triggered. All four historical profile-sync jobs remain waiting_provider,
with unchanged latest update time 2026-08-27T12:55:24.435461Z; manual-only recovery
was preserved. Configured paid providers remain enabled.

IMPLEMENTED, TESTED and LOCAL_RUNTIME verified for this defect. This is not
external deployment acceptance, real-provider generation acceptance, or human UAT.
An empty fresh project means generation has not been started, not generation failed.
