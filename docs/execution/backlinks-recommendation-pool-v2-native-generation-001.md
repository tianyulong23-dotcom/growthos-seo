# BACKLINKS-RECOMMENDATION-POOL-V2-NATIVE-GENERATION-001

## Start Card

- Started at: `2026-09-02T11:55:18+08:00`
- Repository: `C:\Users\DELL\Documents\缝合\john3947-seo-main`
- Branch: `main`
- Baseline HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`
- Target project: `68299b17-33d6-4993-b106-cf24f1f880bc`
- Product path: `/projects/:projectId/backlinks/recommendations`
- Objective: create and publish a new native V2 recommendation generation for the active project instead of treating migrated V1 websites as the current pool.
- Real-provider authorization: DataForSEO, AI, Browser, and Temporal business calls needed by one target-project recommendation generation.
- Provider ceiling: DataForSEO discovery cost must not exceed `$2.00` in total; each discovery round must not exceed `$1.00`.
- Explicit exclusions: no Gmail send or sync, no deployment, no commit, no push, no manual database repair, and no project-specific hardcoding.
- Stop point: the target project has one newly generated native V2 pool published through the product path, with database, API, and UI evidence and no active V1 generation or V1 refill/provider writes.

## Baseline

- The active project contract is `recommendation-pool.v2` and `V2_ACTIVE`.
- The visible generation is `2`.
- The visible batch contains 10 websites, all marked `legacy_imported=true`.
- Native V2 seed count, discovery round count, and terminal discovery fact count are all `0`.
- The V2 workflow engine exists, but the product runtime has no user-facing command that creates a new immutable native generation and starts it.
- The recommendation feed query reads all active publications for the project/user and does not bind results to the active generation.

## Ownership Ledger

The worktree was already materially dirty before this task. Existing changes are protected and will not be reverted or cleaned.

Expected task-owned paths:

- `docs/execution/backlinks-recommendation-pool-v2-native-generation-001.md`
- V2 recommendation command/API/runtime files required for native generation creation
- recommendation feed repository and focused tests required to enforce current-generation visibility
- recommendation page/API client files required for an explicit native V2 generation command

## Evidence Layers

- IMPLEMENTED: pending
- TESTED: pending
- LOCAL_RUNTIME: pending
- REAL_PROVIDER: pending
- SAMPLE_ACCEPTANCE: pending
- DEPLOYMENT: not authorized
- HUMAN_UAT: pending
