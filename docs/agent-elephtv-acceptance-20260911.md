# ElephTV Agent Acceptance

## Start Card

- Task: AGENT-ELEPHTV-ACCEPTANCE-002.
- Authorization: user permits a real ElephTV Agent read acceptance, then the next
  stage only after acceptance passes.
- Repository: john3947-seo-main, main, HEAD 506d88f.
- Preserve: all previous uncommitted read-stage changes and .codex-checkpoints/.
- Project: 7e1c7515-b9b3-4247-80ed-12b3eecee3a2, ElephTV, elephtvza.com.
- Scope: Agent runtime/read adapter/tests; real page/data comparison. No unrelated
  Core, provider, migration or frontend redesign.
- Runtime: isolated acceptance API/frontend and Agent task queue using the existing
  database. Do not consume historical Agent queues or restart shared Core services.
- Provider budget: at most two acceptance conversations, eight model rounds each,
  USD 0.50 configured model budget per run (reservation/accounting rules apply).
  No Gmail sends/syncs, paid discovery or external business commands.
- Side effects allowed: acceptance conversation/run/tool execution audit records.
- Commit/push: not authorized this stage.
- Stop: if read acceptance fails, fix and revalidate it before adding execution.
  A next-stage implementation does not authorize real outreach sends.

## Initial Observation

Existing UI shows seven visible recommendations, eight published in the generation,
and thirty-eight discovered/prepared. These are different counts. Recommendation
metrics are unavailable, not zero. All seven visible entries show an existing
opportunity. No Agent Worker was running at inspection time.

## Runtime Findings And Fixes

1. Agent conversation GET returned 404 although the project and recommendation
   page were readable. AgentService used the legacy `local` organization instead
   of the explicitly configured local platform tenant. The service now copies
   settings for this explicit non-production mode only, including the local actor.
   Shared settings and production identity are not changed.
2. After that fix, the first acceptance run failed with
   `model_provider_not_configured`. The configured model existed under the actual
   project organization, but ModelGateway read the default organization. Model
   activities now bind settings lookup to the repository-owned run organization,
   not workflow payload/model arguments. No cross-organization fallback is used.

Conversation: `518599c4-5a4b-466f-99c6-7318aefbd395`.

- First run: `041d84b1-98c1-4e1a-ae39-bd831c278178`, failed before provider submission.
- Retry: `dfa5d774-dacd-4a31-bc68-66d0edb17281`, failed with
  `model_provider_request_rejected` / HTTP 400, zero tool calls.
- One bounded diagnostic request containing only `Reply OK.` (32 output tokens,
  45-second timeout, no retries) returned HTTP 429. The configured relay reported
  all available accounts rate-limited. This does NOT explain or resolve the
  earlier HTTP 400; no further provider retries or configuration changes made.
- Both conversation runs are terminal. Zero reported usage is not proof of
  provider-side billing. No business write, email send, Gmail sync or discovery
  was executed.

## Direct Read And Page Evidence

The production BacklinksReader was called directly against this real project,
separately from the failed model run. All six tools returned valid scoped evidence:

| Tool | Observation |
| --- | --- |
| Recommendations | 7 items, matching visible domains; missing metrics remain null |
| Opportunities | 3 items, no next page; all JOINED / ACTIVE / OPEN |
| Opportunity detail | First list ID resolved within this project |
| Contacts | 1 existing contact for that opportunity; no discovery or selection |
| Mail metadata | 0 items, no next page |
| Links | 0 items, no next page; not an externally verified backlink census |

Browser comparison covered recommendation, opportunity and mail pages:

- Generation statistics (38 discovered/prepared, 8 published) are not the current
  visible recommendation count (7).
- Current opportunity list has 3 rows although all 7 recommendation cards show
  joined state. Current-list filtering/history must be investigated before making
  a reconciliation claim.
- Opportunity headline says 3 contacts pending / 0 contactable, while the API has
  three EMAIL_READY paths and contact addresses. The frontend headline currently
  counts JOINED business stages, not actual contact readiness
  (`opportunities-workspace.tsx`). Treat as an existing semantic discrepancy,
  not proof that contacts are absent. No unrelated frontend edit made.
- Mail page has no saved messages and reports Gmail refresh credentials unavailable.
  The six read tools do not currently expose account readiness; do not infer
  send readiness from an empty message collection.

## Gate Result

- IMPLEMENTED: local Agent tenant and model-settings scoping fixes.
- TESTED: 434 focused Agent, gateway and platform-auth tests passed in 33.58s;
  `git diff --check` passed. Tests include explicit local-mode identity, unchanged
  shared/production settings, organization-scoped model lookup, and ignoring a
  forged organization in the workflow payload.
- LOCAL_RUNTIME: real-project adapter reads and page inspection passed as above.
- REAL_PROVIDER: blocked by actual relay failures.
- SAMPLE_ACCEPTANCE: BLOCKED; no successful model answer exists to compare.
- NEXT EXECUTION STAGE: NOT ENTERED. Resume answer acceptance once the configured
  relay is available; diagnose HTTP 400 if it persists. Then reconcile page
  semantics and design the first explicitly approved reversible action.
- DEPLOYMENT / PUSH / HUMAN_UAT: not performed.

At close-out, all dedicated acceptance API/Worker/Vite processes were stopped
after PID/command ownership checks. Existing shared UI (5173, PID 8924) and API
(7200, PID 23704) remain running and were not restarted. Fixes are in source and
were verified in the isolated runtime, not loaded into the shared API process.

## GPT-5.5 Rerun - September 11, 2026

This rerun supersedes the blocked REAL_PROVIDER and SAMPLE_ACCEPTANCE results
above for the bounded read-only sample, while preserving the original failures.

- Saved Agent override: `gpt-5.5`; existing gateway/key/chat_completions retained.
- Synthetic plain response, tool calling and streaming probes: PASS.
- Browser-submitted conversation: `37ad749f-2299-403f-8f8a-8d7d6f2b8838`.
- Run: `026808ad-22a1-40dc-92fd-f18ef5cf0e82`, completed, zero failed steps,
  null error_code/error_message and no pending action.
- Two model calls and four completed read tools: recommendations, opportunities,
  mail metadata and links. Reported usage: 16,127 tokens. Recorded USD cost is
  zero, but pricing is unverified; this is not evidence of free provider usage.
- Final answer rendered in the browser. Fresh API comparison confirms 7
  recommendations, 3 opportunities, 0 mail records and 0 links, no next pages.
- Answer correctly distinguishes 38 admitted/effective candidates, 8 released
  and 7 currently visible recommendations. Missing metrics remain unknown.
- Opportunity API confirms JOINED/ACTIVE/OPEN and next actions of two REVIEW_DRAFT
  plus one CREATE_EMAIL_DRAFT. Link evidence freshness is unknown, not proof of
  an externally verified zero-backlink census.
- Recommendation, opportunity and mail pages were inspected again. Existing
  contact-readiness headline discrepancy and unavailable Gmail refresh
  credentials remain; neither was fixed or hidden by the successful model run.
- REAL_PROVIDER: PASS for these calls; no HTTP 400/429 occurred in this rerun.
  The historical mini-model routing failure is not thereby diagnosed.
- SAMPLE_ACCEPTANCE: PASS for this four-list read-only request. Detail/contact
  tools retain earlier direct-adapter coverage, not new model-invoked coverage.
- No backlink business write, discovery, Gmail sync or send was requested.
  Only Agent conversation/run records were created.
- NEXT EXECUTION STAGE: NOT ENTERED. This is isolated local acceptance on
  UI 5183 / API 7211, not shared-worker reload, deployment or full-flow acceptance.
- Cleanup: owned API/Agent worker/Vite processes stopped after command checks;
  acceptance ports closed. Existing 5173/PID 8924 and 7200/PID 23704 remained
  listening. `git diff --check` passed (existing line-ending warnings only).
