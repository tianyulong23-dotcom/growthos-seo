# Agent Provider Diagnosis

- Task: AGENT-PROVIDER-DIAGNOSIS-003.
- Authorization: diagnose the existing relay, then revalidate Agent only after
  each preceding check passes. No business write, Gmail, discovery or push.
- Repository: main, HEAD 506d88fac0fa81503e54aebdfc4ac9e68974997b.
- Preserve all dirty read-stage and tenant-scope changes and checkpoints.
- Ownership: provider error diagnostics, focused tests, this report and ignored
  local diagnostic helpers. No shared service restart or saved provider changes.
- Budget: at most three synthetic provider checks (plain, tool, streaming),
  no automatic retries, 45 seconds per check, at most 128 output tokens each.
  Stop on failure. Model answer acceptance remains separately gated and bounded
  by the existing ElephTV acceptance card.
- Diagnostics: no raw response body, prompt, key, address or arbitrary error text.
  Log bounded allowlisted error metadata and recognized reason categories only.
- Verification: privacy regression tests, existing provider tests, then actual
  bounded provider check. Do not equate fixture success with provider recovery.

## Result

- IMPLEMENTED: shared OpenAI-compatible provider error classifier emits bounded,
  allowlisted diagnostics. Arbitrary error bodies/messages, headers and unknown
  metadata are excluded. Retry behavior and user-facing errors are unchanged.
- TESTED: 108 provider diagnostic, model gateway and privacy tests passed in
  17.91 seconds. `git diff --check` passed.
- REAL_PROVIDER: one synthetic plain-text request, no retries, no project data.
  Failed with HTTP 429 / `rate_limit_error` /
  `relay_accounts_rate_limited` on 2026-09-11, approximately 14:46 Asia/Shanghai.
- Request ID: `d153609f-434b-4c29-ae65-9c85404ac4c3`.
- Relay: `sub2.indexarc.net`; configured model/protocol unchanged.
- Tool and streaming checks were NOT submitted because the first check failed.
  No ElephTV model acceptance run was started in this task.
- Billing: response supplied no usage; provider-side charges are not verified.
- Original HTTP 400 root cause remains unproven. The new 429 is evidence of the
  current relay-account capacity failure, not retrospective proof of the 400.
- External action: ask the relay operator to trace the request ID, restore a
  usable upstream account/channel, and confirm when plain chat requests work.
  Do not change network proxy, model or saved credentials without evidence.
- Resume: plain text -> synthetic tool call -> streaming -> bounded ElephTV
  answer acceptance. On a renewed 400, inspect diagnostic type/code/param and
  correlate the request ID with the relay operator before changing payloads.
- Status: PASS_CODE_PROVIDER_INPUT_REQUIRED. Execution stage remains gated.
- Existing UI/API processes remained unchanged; no background helper remains
  from this diagnostic invocation. No business mutation, commit or push.

## Codex Comparison Follow-Up

User requests comparing the working Codex setup against the project Agent.
Read local Codex configuration and compare credentials in memory, printing only
an equality boolean. Disk configuration does not prove active session routing.
Do not transfer Codex credentials to the project or modify either saved config.
Allow at most three synthetic requests with the existing project credential:
current Agent model/protocol, same model with Responses, then the configured
Codex model with Responses. Each is capped at 128 output tokens, 30-second
timeout and zero retries. No project data or business tools. These bounded
A/B checks are a new diagnosis scope, not a repeat loop after rate limiting.

### Comparison Results (2026-09-11, About 14:58 Asia/Shanghai)

All three calls used the same existing PROJECT credential and gateway.
No Codex credential was transmitted or copied.

| Model | Protocol | Actual result |
| --- | --- | --- |
| gpt-5.4-mini | chat_completions | HTTP 429, relay_accounts_rate_limited |
| gpt-5.4-mini | responses | HTTP 429, relay_accounts_rate_limited |
| gpt-6-astra | responses | Success, nonempty text, response model gpt-6-astra |

Request IDs for the failed cases:
`b289e9a3-1217-41df-b9eb-a95312b1edda`,
`3cc71deb-7eb0-415d-9c35-4d98c5c0b5bd`.
Successful response reports input 4123, cached input 3968, output 5, total 4128
tokens; cost is not reported. This is upstream-reported accounting, not a
verified explanation for why a tiny synthetic prompt has that input count.

Conclusion: the gateway and project credential can complete a request for at
least one model. A blanket claim that the entire gateway/account pool is
unavailable is not supported. Evidence points to the gpt-5.4-mini route/pool,
model availability or key-specific model routing. Only the relay operator can
confirm the internal cause. Merely changing the mini protocol did not fix it.
The original full Agent HTTP 400 is still not diagnosed.

Local Codex config names gpt-6-astra / responses / the same base URL. However,
auth.json indicates chatgpt OAuth mode with no OPENAI_API_KEY, so exact credential
equality and current-session routing cannot be established from these files.
Do not claim the active Codex chat necessarily uses that gateway.

Next: validate tool calling and streaming on the working model in isolation.
Before saving a model/protocol change, account for task-wide protocol scope and
unknown model pricing; do not change all project AI jobs to a new model merely
to repair Agent. No saved settings changed during this comparison.

### Authorized Agent Model Change

User explicitly requests changing the local Agent to 5.5, interpreted as the
gateway model identifier `gpt-5.5`. Change only `agent_model` using the supported
project settings API. This is the organization's Agent task override, not a
per-project-only model. Preserve every other editable field and existing key;
save the public settings response as an ignored local rollback record first.
Read back and verify only agent_model/updated_at changed. One synthetic probe
allowed, 128 output tokens, 30-second timeout, no retries or project data.
No shared service restart, business execution or Git publication.

Result: SAVED and read back `agent_model=gpt-5.5`. Only `agent_model` and
`updated_at` changed. Default model remains gpt-5.4-mini; protocol remains
chat_completions, existing credentials unchanged. Scoped ModelGateway lookup
resolved gpt-5.5. The single actual probe succeeded with nonempty text and
response_model gpt-5.5, reporting 9 input / 5 output / 14 total tokens, no cost.
Rollback public snapshot: `.runtime/agent-backlinks-20260911/before-agent-gpt55.json`.
This verifies saved configuration and a plain model response, not tool calling,
streaming, shared-worker reload or the full ElephTV business acceptance.

### Authorized Rerun Result

Following the user's request, plain response, synthetic tool calling and
streaming all passed with the saved gpt-5.5 Agent override. A browser-submitted
ElephTV read-only run then completed with two model calls and four read tools,
zero failed steps and a rendered final answer matching current scoped data.
Run: `026808ad-22a1-40dc-92fd-f18ef5cf0e82`.
See `agent-elephtv-acceptance-20260911.md` for comparison and remaining limits.
This establishes a working gpt-5.5 path for this sample, not the cause of the
earlier mini-model failures or long-term relay availability. No shared service
restart, business execution or Git publication was performed.
