# Agent delegated draft execution - 2026-09-11

## Boundary

User authorized authenticated delegation and the existing create draft job ->
query job -> inspect draft chain, plus Gmail diagnosis. No approval, sending,
mailbox sync, contact discovery, DataForSEO, commit or push.

Baseline: main at 506d88fac0fa81503e54aebdfc4ac9e68974997b. Existing dirty
Agent, frontend and acceptance work belongs to earlier tasks and is retained.
This task owns additive delegation/draft modules and focused integration edits
in Agent routes/service/tools/activities and platform authentication expiry.
No unrelated frontend edits.

Verification ceiling: mocked provider tests first. At most one local ElephTV
draft job after checking its opportunity/contact again; at most one Agent run
(8 rounds, USD 0.50 configured Agent ceiling). Core draft generation has a
separate provider/budget and must be checked before that sample. Gmail diagnosis
does not send or synchronize mail; no OAuth disconnect/revoke.

Stop on missing authority, scope mismatch, expired delegation, provider budget
uncertainty or unsafe draft state. Do not substitute template success for AI
success. Implementation, tests, local runtime and real-provider acceptance are
reported separately.

## Runtime Preflight

- Dedicated API 7211, Agent queue agent-backlinks-acceptance-20260911.
- Core worker configuration (read-only process inspection): draft model
  gpt-5.6-terra, gateway sub2.indexarc.net, 20,000 input / 1,200 output tokens;
  outreach draft budget USD 0.10 per configured window. One draft job can reserve
  two provider attempts. This is independent of Agent gpt-5.5. No model override.
- ElephTV barnardmedia.co.za opportunity ebe03fcf-1aad-43a5-bc13-20279636a23c
  still has no draft, version 1, CREATE_EMAIL_DRAFT enabled. Confirmed active
  non-guessed contact 0d7fc464-f56a-45c4-8a85-daca15501b4d is version 1.
  Project profile key_pages contains https://elephtvza.com/.
- Gmail: worker PID 29504 inherited HTTP_PROXY and HTTPS_PROXY pointing at
  http://127.0.0.1:33210. That port has no listener. Structured token-health
  failures report ECONNREFUSED with no Google HTTP response. A credential-free
  direct POST to Google's token endpoint timed out at five seconds. This is
  transport failure, not evidence of revoked OAuth authorization. System proxy
  is currently disabled; restarting unchanged without a working route is not
  a demonstrated repair. No mailbox or authorization mutation performed.

First Agent run 6ca4af16-b953-4963-9d1d-74ed57fb36b9 created exactly one job:
d302d6c8-2855-4d6c-8bb5-f49c7180267e, draft
90fbd037-bdbc-44d1-9bae-9a79ab2a794e. It honestly reported RUNNING rather than
claiming generated text. Core subsequently returned SUCCEEDED / AI_DRAFT_READY,
MODEL source, FRESH, unapproved draft. During this sample, get_project_profile
exposed an existing default-organization/workspace lookup mismatch. The reader
now uses the authoritative run organization and delegated workspace.

Verification budget adjustment: permit one additional read-only Agent turn to
check the completed job/draft and corrected profile, no new generation. Combined
model-round ceiling remains eight actual rounds; each configured run limit is
USD 0.50. Do not present that configured limit as measured gateway billing.

## Acceptance Results

- Read-only follow-up run 49a42182-600a-4729-b704-d4bcc49f3ffe queried the
  completed job and inspected the draft. Six actual Agent model calls across
  both runs; one draft job only. No approval, sending or mailbox synchronization.
- Draft subject: Exploring a partnership with ElephTV. The stored draft has
  text, matches the contact snapshot, is FRESH, is MODEL / AI_DRAFT_READY,
  and remains unapproved.
- The follow-up exposed that correcting organization alone was insufficient:
  the profile reader also needs the delegated workspace. After that correction,
  the same registered profile/job/draft tools were invoked with the persisted
  run grant against real data. Profile domain elephtvza.com, job SUCCEEDED,
  and all five draft checks passed. This final check used zero model calls
  and performed zero writes; it was not another end-to-end model run.
- Delegation is server-signed, project/tenant-bound, permission-attenuated and
  limited to 15 minutes or the initiating token expiry, whichever is earlier.
  Tool arguments cannot supply authority. This is a short-lived permission
  snapshot, not an instantaneous membership-revocation system. Production
  authentication contracts are tested; real production login is not accepted
  by this local-development sample.
- Gmail remains blocked by GMAIL_TOKEN_REFRESH_FAILED. The retained
  CONNECTED record and scopes do not prove a currently usable access token.
  GOOGLE_AUTH_TEMPORARY_FAILURE plus ECONNREFUSED and the dead proxy listener
  identify a transport problem, independent of Agent gateway rate limits.
  Restore a working proxy or configure a verified replacement before a
  controlled Core restart and token-health check. Reauthorize only if Google
  then returns an authorization error such as invalid_grant.
- Full test discovery reached three Temporal takeover failures because
  database seo_agent_v11_test does not exist, with 203 passed and 2 skipped
  before stopping. Do not redirect those destructive integration fixtures
  into the shared project database.
- Final non-Temporal/non-Postgres Agent suite plus platform authentication
  and request-context tests: 433 passed. The state-changing-tool catalog
  assertion now includes create_backlink_draft. Integration tests requiring
  their dedicated infrastructure remain outside this passing result.
- Dedicated acceptance API 7211, UI 5183 and Agent worker were stopped.
  Shared listeners 5173 / 7200 / 7301 / 7302 remained running.
- Shared main services were not restarted or deployed by this task.
  No commit or push was performed. The persisted sample draft is retained.

## Main Runtime Activation (Subsequent Authorized Turn)

User clarified that Agent should use the project and execute connected backlink
tasks, and explicitly excluded Gmail repair. Delegation boundaries remain:
project access is allowed, cross-tenant access or self-issued permissions are not.

- Found a startup gap: dev-up.ps1 stops Docker agent-worker but did not launch
  a replacement local worker. It now starts and registers Agent Worker with
  the same environment as Platform API, using existing managed-process helpers.
  All 11 startup source tests passed, including the new worker registration test.
- Temporal preflight found zero running AgentWorkflow executions. Restarted
  Platform API only and started the daily agent-ai queue worker. Core/Gmail
  processes were not restarted. An initial activation attempt used the base
  Python interpreter and failed on growthos_provider_archive import; recovered
  using the repository virtualenv and provider_archive PYTHONPATH.
- Main API /health returned 200; /api/v1/runtime-status returned status ok,
  mode PRODUCT. Main services are now using the implemented Agent tools.
- Real conversation through port 7200:
  6049a834-d88a-49c8-99f2-1a466d569d9f, run
  3ef72258-0ed6-4e6e-a29e-ca1497e3d44e, COMPLETED.
  get_project_profile, get_backlink_draft_job and get_backlink_draft all
  completed. Two model calls. Agent reported elephtvza.com, SUCCEEDED,
  AI_DRAFT_READY, FRESH, matching contact snapshot and an unapproved draft.
  This was read-only business verification; no new draft job or Gmail action.
- The three blocked takeover tests simulate worker loss for business-profile
  update/refresh and technical audit. They require seo_agent_v11_test to
  isolate destructive fixtures, and failed before the recovery scenario because
  that database is absent. This is not a diagnosed production Temporal failure.
  Dedicated-infrastructure takeover acceptance remains unverified.
- Connected scope is project/backlink reads and create/query/inspect draft.
  This does not claim full backlink lifecycle coverage or enable mail sending.
