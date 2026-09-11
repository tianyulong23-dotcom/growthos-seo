# First recommendation generation bootstrap - 2026-09-08

## Scope and ownership

- Repository: `john3947-seo-main`, branch `main`, baseline HEAD `7df8d48d088328bd79fb0a1afef364b17cc8b6af`.
- The worktree already contained extensive changes. This repair preserves them.
- Scope: shared first-generation seed preview, confirmation, worker eligibility,
  native V2 input pins, and generation status before the first published batch.
- No live SQL mutation, additional budget allowance, historical sync resume, or
  Gmail send was used.

## Root causes and shared repair

1. Seed preview required an existing generation. A fresh V2 project therefore
   could not prepare seeds needed to create its first generation.
   `recommendation-seed.repository.ts` now reads the tenant/project's active
   context and matching V2 input pins for a read-only initial preview.
   Confirmation creates the native generation idempotently; preview does not.
2. The discovery worker required a populated project generation/context binding.
   A legitimate initial `V2_READY` project has neither. The runtime admits this
   exact initial state while preserving scope, generation, and budget checks.
3. Native seed readiness and input loading still selected the legacy
   qualification contract. The worker now uses the generation's exact input pin
   and V2 admission contract for confirmed native V2 seeds.
4. The empty feed hid staged/running first generations. It now returns their
   status even without published items. Running contact preparation is shown as
   in progress, and obsolete terminal errors are not projected as current while
   a recovered job is running.

## Regression evidence

- Before the preview repair, the new-project integration regression reproduced
  HTTP 409: `Recommendation pool V2 has no complete pinned seed snapshot.`
- The integration test covers deterministic read-only preview, idempotent
  confirmation, one generation/launch, zero paid requests, and the actual
  discovery runtime's eligibility/context/input-pin gate.
- Discovery execution deliberately stops at an injected test request port,
  after real repository/readiness checks and before external provider use.
- Initial combined parallel integration execution hit PostgreSQL shared role
  DDL contention (`tuple concurrently updated`). Serial rerun:
  **12 files, 89 tests passed** using `vitest run --no-file-parallelism`.
- Frontend `test:project-authority-source`: **3 passed**.
- Core `npm run build`: passed. `git diff --check`: passed (line-ending warnings).

## Local runtime evidence at 18:30 CST

- Original project: `7e1c7515-b9b3-4247-80ed-12b3eecee3a2` (`elephtvza.com`).
- Browser preview returned five seeds; confirmation and one launch created
  generation `7383be94-160c-45c9-ac62-7195181ded23` (generation 1).
- Two downstream defects were exposed during real execution and repaired.
  Supported Temporal resets recovered the same workflow/generation, without
  creating another batch. No reset was made after successful paid discovery.
- Eight DataForSEO discovery request records succeeded; 38 unique candidates
  were discovered and 16 contact preparation jobs were created.
- At this snapshot the job is running in `canonical_batch_preparation`, not
  failed or published. Contact outcomes include completed and partially
  completed jobs; remaining work follows the existing bounded retry policy.
- Original browser displays generation 1, 38 discovered sites, contact
  preparation in progress, zero published results, and no obsolete ended/error
  message. Screenshot:
  `.playwright-cli/page-2026-09-08T10-30-01-970Z.png`.
- Existing Snapmaker project was refreshed through the original UI: 16
  published recommendations remain visible.
- API build: `local-product-ef0a6a63024b6c4e8597ad54`.
- Running worker build: `local-product-6f7835f7854b5378daed3ed9`, which contains
  the execution fixes. Only the API was restarted for the final read-projection
  change to avoid interrupting active contact-provider work.

## Final publication verification at 18:35 CST

- The same job reached `success / published`, progress 100, released count 8.
- All 16 contact jobs reached terminal outcomes: 3 completed, 13 partially
  completed. Partial completion does not mean every site has a usable contact.
- Original UI now displays generation 1 completed, 38 discovered/admitted,
  8 published, and a selectable first batch containing 8 results.
- Final screenshot: `.playwright-cli/page-2026-09-08T10-35-12-285Z.png`.
- After verifying no running recommendation/contact jobs, API and worker were
  restarted on the same build `local-product-ef0a6a63024b6c4e8597ad54`.
- Adjacent product-quality issue remains: the visible results include
  `android.com`, and SEO metrics remain unknown on the inspected entries.
  This first-generation bootstrap repair does not establish that suitability
  filtering or metric coverage meets the earlier full V2 acceptance criteria.

These results establish implementation, automated regression, local UI, real
discovery execution, and first-batch publication. They do not assert full
recommendation-quality acceptance, Gate 10 acceptance, remote deployment, or
human UAT.
