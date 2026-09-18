# Multi-task phases 1 and 2 - 2026-09-15

## Scope

User authorized inventory and localized page progress recovery fixes.
Source root: `john3947-seo-main`, branch `main`, initial HEAD
`506d88fac0fa81503e54aebdfc4ac9e68974997b`.
Existing dirty and untracked work was preserved.

No business tasks, paid providers, real email, database migrations, service
restarts, dispatcher settings, commits or pushes were performed.
Global task aggregation and Agent background handoff remain outside this phase.

## Inventory

| Area | Existing behavior and relevant source | Finding |
| --- | --- | --- |
| Articles | `backend/api/app/modules/content/service.py` persists runs and starts Temporal workflows; `frontend/src/features/content/article-workspace.tsx` restores selected article state | Task execution is separate from the page; transient progress-read failure could permanently stop its observer |
| Audit | `frontend/src/pages/module-page.tsx` restores project/run selection; `frontend/src/features/audit/use-audit-run-polling.ts` observes active runs | Same transient-read polling defect |
| Keywords | `frontend/src/features/keywords/keyword-workspace.tsx` restores runs and schedules polling after query errors | Existing retry and selection guards retained; no production edits |
| Recommendation pool | `frontend/src/features/outreach/recommendations/recommendation-feed-workspace.tsx` derives polling from generation status | A transient query error cleared active status and could stop polling; hook data needed explicit query-key isolation |
| Content plan | `frontend/src/features/content/content-plan.tsx` reads the selected month on entry | Active list rows were not periodically refreshed while remaining on the page |
| Mail | `frontend/src/features/outreach/mail/mail-center.tsx` reads saved correspondence on entry and polls; draft inbox reads on entry/revision/cursor changes | Existing read cleanup does not itself cancel backend sending; draft list does not continuously discover new background drafts while staying open |
| Agent | `backend/api/app/modules/agent/repository.py` persists runs/dispatch and guards active runs per conversation; `frontend/src/features/agent/use-agent-conversation.ts` restores conversation state | Existing behavior retained; background handoff and concurrent conversations were not changed |
| Performance | `frontend/src/features/performance/performance-workspace.tsx` uses request guards and reloads on entry | Continuous sync-progress observation needs separate verification |
| Global task UI | `frontend/src/app/app-shell.tsx`, `HeaderActions` | Current task entries are local static examples, not a live cross-project task registry |

## Implemented

1. Article progress observer retries after transient read errors, waits for each
   read before scheduling another, and stops at a terminal status or unmount.
2. Audit observer applies the same retry behavior and guards responses against
   a changed selected project/run.
3. Recommendation feed and status hooks retain same-query data on transient
   failures, hide data from other query keys, and ignore superseded responses.
   Explicit 403/409 responses clear data. Initial failures without prior data
   still use the existing refresh path.
4. Content plan refreshes active rows every three seconds after each completed
   read, retains rows through transient failures, and stops observing on
   unmount or when no rows are active.

All production edits are limited to these four frontend files and their four
focused test files. Timer cleanup stops observation, not the business task.

## Verification

- Before fixes: three new hook regressions failed (10 other tests passed):
  article retry, audit retry, and retaining running recommendation status.
- Before content-plan fix: active-list refresh regression failed; six other
  tests were skipped for that focused reproduction.
- After fixes: 23 focused tests passed.
- Adjacent regression suite: 10 files, 113 tests passed, covering the hooks,
  content plan, article workspace, module navigation, keywords, project query
  cache, draft inbox and mail center. The supplied Agent conversation test
  path was not collected in this run; do not count it as Agent coverage.
- `tsc -b --pretty false`: passed after correcting browser timer types.
- ESLint over all eight edited frontend files: passed.
- Scoped `git diff --check`: passed; only existing LF/CRLF conversion warnings.

Tests use mocked APIs. They establish UI observer retry, late-response
isolation, independent observers, terminal stopping and remount recovery.
They do not prove concurrent real-provider execution, delivery, worker capacity
or browser/manual acceptance. Runtime services and flags were not changed or
revalidated in this phase.

## Remaining Boundaries

- Recommendation workspace still contains an initial feed publication action
  on page entry. Fully unattended continuation needs backend-path verification;
  page recovery tests alone do not establish it.
- Continuous discovery of new drafts while staying in the draft inbox and
  performance sync progress are not covered by these localized fixes.
- No new global task center, unified task registry, concurrency controls or
  Agent background handoff was introduced.
- A later acceptance phase should run isolated projects across article
  generation, recommendation generation and controlled email tasks, then verify
  navigation, refresh, partial failure and service restart recovery.
- Shared send-account queues must retain their existing serialized scheduling
  across projects. This phase did not change sending or imply delivery guarantees.

Status: IMPLEMENTED and TESTED for the four localized fixes.
LOCAL_RUNTIME, REAL_PROVIDER and HUMAN_UAT acceptance remain unclaimed.
