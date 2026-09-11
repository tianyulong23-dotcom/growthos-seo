# New-project recommendation entry repair

Date: 2026-09-08

## Scope and ownership

Root: john3947-seo-main, branch main, baseline HEAD
7df8d48d088328bd79fb0a1afef364b17cc8b6af.
The worktree already contained extensive user/task changes. This repair only
changes the recommendation route composition, its existing promotion-target
gate, and focused regression tests. Existing changes are preserved.
No provider calls, generation launches, Gmail sends, historical job resumes,
manual database repairs, or backend restarts are part of this repair.

## Reproduction and cause

Project 7e1c7515-b9b3-4247-80ed-12b3eecee3a2 (elephtvza.com) had a published
business profile but no promotion target. Its audit event explicitly required
WEBSITE_PROJECT:publish_promotion_target. Core had zero project snapshots and
zero generation contracts. Feed and release-status reads returned 404.

The V2 route mounted RecommendationFeedWorkspace directly, bypassing the
existing RecommendationProjectGate. The gate's isolated tests did not prove
production composition. Its old inventory probe also needed replacement by
the V2 status endpoint.

## Repair

- Wire the prerequisite gate into the actual recommendations branch.
- Scope its lifetime to project ID and context version.
- Reuse editable suggested topics and same-project URLs; explicit confirmation
  uses the existing promotion-target publication and projection transaction.
- Verify readiness with V2 release status, retry transient projection 404s,
  and mount the feed only once the project is ready.
- Distinguish missing inputs, archived projects, readiness errors, and
  projection delays. Keep all backend admission rules.
- Reject mismatched and aborted readiness responses.
- Preserve repeated polling while website understanding is still refreshing.
- Confirmation is not a paid generation launch. Runtime project-analysis
  composition passes no provider-analysis or recommendation-refill port.

## Evidence

- New production-wiring assertion failed before the repair and passed after.
- Focused frontend suite: 22 tests passed across promotion-target setup,
  production wiring, and the V2 workspace.
- Promotion-target API tests: 3 passed.
- Frontend typecheck passed.
- Original project, actual browser: editable promotion setup is shown instead
  of the generic feed error. Desktop and 390px mobile screenshots inspected.
  Mobile document width is 390px, with no horizontal overflow.
- Existing active Snapmaker project: V2 feed still displays 16 released sites.
- Archived projects are reported as archived, not as failed generations.

Screenshots: storage/runtime/promotion-gate-desktop-20260908.png and
storage/runtime/promotion-gate-mobile-20260908.png.

## Acceptance boundary

The original project's promotion selection was not confirmed on the user's
behalf. Confirmation-to-ready is covered by focused mocked tests and API tests,
not a live end-to-end publication in this turn. The project is awaiting user
confirmation of the prefilled promotion scope, then an explicit generation
action. This is not evidence of completed generation or a new Gate 10 PASS.
