# Agent Integration Acceptance - 2026-09-11

## Scope and Preservation

- Local starting HEAD: `7df8d48d088328bd79fb0a1afef364b17cc8b6af`.
- Agent source: `66b4aaffcaccbfb501f46fa32606a61ed7af036d`.
- Local source snapshot: `e6c2c57477b240d6961cc2787608b7d72c767963`.
- Integration was performed in a separate worktree before updating the working branch.
- The snapshot manifest covers 2,235 tracked/nonignored source and evidence entries,
  including deleted paths. Raw file hashes, original index, patches and a verified
  Git bundle are retained outside the source repository.
- The existing local changes cover 466 publishable changed files. They are preserved,
  not represented as changes authored or comprehensively validated by this integration.
- 285 local checkpoint files remain local. Runtime state, credentials, dependencies,
  browser artifacts and backup bundles are not publication inputs.
- The bundled publisher resource catalog is intentional application data. Its existing
  bundle check passed: 49,742 rows and 49,737 domains.
- Publication target is the existing remote branch named by the user, not remote main.

## Changes

1. Scroll following now responds to successive runtime content updates, including
   updates sharing the same stream event type. Manual scroll-away remains respected;
   switching conversations resets the viewport.
2. Persisted onboarding welcome messages render as paragraphs, not compact task badges.
   Confirmation actions and failure/retry controls remain visible.
3. Markdown spacing cleanup uses parsed code positions to preserve literal fenced,
   indented, incomplete-fence and multiline inline code.
4. `remark-parse` and `unified`, already present in the lockfile, are explicit direct
   dependencies. No package upgrades were required.
5. Two existing recommendation test fixtures now declare their known non-null
   generation data, fixing four baseline TypeScript errors without changing
   recommendation production behavior.

## Verification

- Before fixes, the new integration unit suite reproduced the defects: 8 failed,
  1 passed. After fixes, all 9 passed.
- Full frontend Vitest suite: 98 files, 642 tests passed.
- Frontend application TypeScript and V2 contract TypeScript checks passed.
- Backend core TypeScript check passed.
- Production frontend build passed, with existing chunk-size/dynamic-import warnings.
- ESLint passed for the Agent implementation and new test files.
- Generated Backlinks client check passed for 89 operations. Its source hash depends
  on raw line endings; the isolated contract input was matched to the original
  checkout's CRLF bytes for this check. No generated-client change is included.
- Final browser selection: 26 passed across desktop 1440x1000 and mobile 390x844.
  Coverage includes welcome paragraphs, profile navigation, retry failure then retry
  success, successive stream updates, manual scroll-away/resume, native V2 release,
  incomplete preparation, recommendation navigation, draft generation/polling,
  simulated send/reply workflows and backlink inventory.
- Desktop/mobile Agent and recommendation screenshots were retained and inspected.
- Original source hashes were checked against the snapshot before local integration.

The browser suite uses intercepted API fixtures and deterministic stream delivery
through the production EventSource adapter. These results are not real-provider,
real-Gmail, deployment, or human-UAT evidence. No provider tasks, database migrations,
real emails or runtime credential changes were performed.

## Pre-existing Browser Failures

The expanded browser run also found the following existing failures, reproduced
against the unchanged original project before integration:

- `outreach-desktop.spec.ts`: unavailable-metrics test expects three old "unknown"
  labels that are no longer rendered.
- `outreach-desktop.spec.ts`: Opportunity/archive flow expects an old status label
  after joining an opportunity.
- `outreach-desktop.spec.ts`: no-contact flow expects an old warning string.
- `outreach-mobile.spec.ts`: an existing primary button fails the serious color
  contrast check (2.62 versus required 4.5).

These tests were not weakened or deleted. The final 26-case selection excludes
these four named baseline scenarios; it is not a claim that the entire existing
browser suite is green. The Agent integration is accepted within the stated scope;
the baseline browser failures remain separate follow-up work.

## Reproduction

From `frontend`, with dependencies already installed:

```text
node node_modules/vitest/vitest.mjs run --maxWorkers=2
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p tsconfig.backlinks-v2-contract.json --noEmit --incremental false
node node_modules/vite/bin/vite.js build
node scripts/generate-backlinks-client.mjs --check
node node_modules/@playwright/test/cli.js test test/agent-integration.spec.ts test/recommendation-feed-phase7.spec.ts test/outreach-desktop.spec.ts test/outreach-mobile.spec.ts --grep-invert "unavailable website metrics|archive, undo|no contact requires|mobile key pages"
```

Use a free `PLAYWRIGHT_PORT` and the installed `PLAYWRIGHT_CHANNEL` as appropriate.
The isolated run used an external Vite config to allow its shared dependency
junction; this machine-specific config is intentionally not part of the source.
