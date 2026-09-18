# Multi-task phase 5: local non-sending acceptance

Date: 2026-09-15.
Root: C:/Users/DELL/Documents/缝合/john3947-seo-main.
Baseline: main, 506d88fac0fa81503e54aebdfc4ac9e68974997b.
Authority: user requested phase 5 after phases 3 and 4.
Scope: load updated services and verify task visibility, isolation, navigation and
Agent handoff without real provider calls or sending.

## Local services

- Confirmed real Platform API at 7200, Core API at 7301 and Core Worker at 7302.
  Reused the frontend at http://127.0.0.1:5173.
- Refreshed idle Platform API and Agent Worker using each process's existing
  environment and command. Refreshed again after the scoped task projection fix.
- Final managed process IDs: Platform API 56016, Agent Worker 58004.
- Core services, database and other workers were not restarted.
- Platform background dispatch remains false; independent Agent dispatch remains
  true. No dispatcher or provider flags were changed.
- Before and after: zero active Agent runs and zero nonterminal send intents.
  Two historical batches retain queued/paused states but are linked to cancelled/
  failed Agent runs. Existing dispatch only selects queued Agent runs; these
  terminal runs are not revived by service refresh. No records were repaired or
  reauthorized. Their stale batch labels remain a separate domain follow-up.

## Real HTTP and browser evidence

- Before refresh the new task routes returned 404. After refresh all five real
  projects returned 200, projecting 44 existing platform task records in total.
- Exact task lookup passed for all five projects.
- Querying a task through a different project's URL returned 404 in all five
  checks. A nonexistent project also returned 404.
- Playwright used real local HTTP, with non-GET/HEAD requests and external network
  blocked. No writes or external requests were attempted during the inspected path.
- Three cross-project task-result navigations selected the correct project and
  restored the linked Agent conversation.
- Desktop 1440x1000 and mobile 390x844 inspected. Mobile task center had no
  horizontal overflow; linked mobile conversation restored with input enabled.
  No page errors. The isolated browser was closed.
- Existing tasks were read, not launched. This verifies real persisted reads and
  navigation, not concurrent real article/recommendation generation.

## Reproduced display fixes

1. Recommendation terminal SUCCESS appeared untranslated. It now displays the
   existing completed label without changing the source status.
2. An onboarding run displayed running despite a failed persisted step. Its
   read-only projection now exposes onboarding_step_failed through a correlated
   EXISTS query. UI displays needs-attention and the failure reason. Raw run/step
   state remains unchanged; completed onboarding runs are excluded from this rule.

Production edits are limited to backend/api/app/modules/tasks.py and
frontend/src/features/tasks/task-api.ts, with their two focused test files.
Concurrent mail-center/automation presentation files were not edited.

## Real Temporal, fixture activities

- Ran the production AgentWorkflow through the existing local Temporal server
  using a unique acceptance-only task queue and fixture activities.
- A waited inside its fixture tool activity while B completed independently.
  Releasing A then completed its command.
- Each command made exactly one model-decision fixture call and one tool fixture
  call. Both persisted finish payloads retained queued background references;
  command completion did not claim business completion.
- Both workflow executions completed; the isolated worker stopped. No business
  job, platform database record, model request, provider request or send was created.
- This verifies workflow transport/concurrency and handoff control flow, not real
  model intent interpretation, production tool execution or Gmail behavior.

## Tests and artifacts

- Backend focused regression: 26 passed (project tasks, task handoff, independent
  Agent dispatch).
- Frontend: 45 passed across tasks, task cards, conversation hook and integration.
- Scoped ESLint and TypeScript checks passed.
- Evidence directory: .codex-checkpoints/multitask-phase5-20260915/.
- probe.json: initial read-only checks and missing route.
- refresh.json and final.json: loaded real routes and cross-project denials.
- runtime-after.json: managed process refresh and Core health responses.
- temporal_handoff.json: isolated real-Temporal execution evidence.
- browser.json: navigation, input availability and network/error checks.
- task-center-live-desktop.png, task-center-live-mobile.png,
  agent-live-mobile.png: real-page screenshots.

## Outcome and remaining boundaries

PASS for scoped local non-sending acceptance. Updated code is loaded locally.
No migrations, real sends, paid provider calls, commits or pushes.

Real multi-provider task execution and human acceptance remain separate gates.
Platform-wide background dispatch was intentionally not enabled by this phase.
The phases 3/4 limitations still apply: standalone draft jobs are not yet included
in the global list, cancellation supports only article/audit/Agent tasks, and
dependent chains require an existing business automation rather than an arbitrary
new orchestration engine.
