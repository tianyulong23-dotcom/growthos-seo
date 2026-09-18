# Gmail Authorization Without Business Projection

## Root Cause

YouCine (`e9074fcb-47e1-46b3-a378-e465b3c123f7`) exists in the
platform but lacks a Backlinks business snapshot. Gmail routes previously
resolved the full recommendation context and failed with HTTP 404 before
OAuth could start. The existing projector correctly refuses a missing
promotion target. Connecting an account must not require inventing one.

## Changes

- Gmail account routes use the signed platform project/tenant identity.
- Gmail-specific context types require ownership, not business metadata.
- Platform Gmail resolution rejects archived projects before issuing context.
- Business context requirements for recommendations, drafts and sends remain.
- Existing UI, Agent orchestration and worker source are unchanged this turn.

## Verification

- Core Gmail route, platform-context contract and disconnect: 26 tests passed.
- Readiness, sync runtime/workflow, send policy and send command: 61 passed.
- Platform context, including archived-project Gmail regression: 16 passed.
- Core TypeScript compilation passed.
- Public frontend-proxy Gmail status: HTTP 200 for YouCine and ElephTV.
- Public OAuth start: HTTP 200, accounts.google.com, PKCE S256, state and
  callback ticket cookie present. No credentials or state values recorded here.
- Actual YouCine mail-center button opened Google's account selection page
  for GrowthOS Backlinks. Stopped before choosing an account or consenting.
- ElephTV opportunity list still returns three records.
- YouCine opportunity/draft list still requires its business snapshot and
  returns 404. This is a separate existing limitation, not a Gmail failure.

## Local Runtime

An isolated artifact directory, `backend/core/dist-gmail-auth-20260915`,
copies the existing runtime and replaces only `gmail-connection.route.js`.
Its patch build identity and runtime module path are separate from shared
`dist`. No unrelated pending Core source changes were deployed.

Core API and Platform API were reloaded using captured current environments.
Only Core artifact path/build identity settings changed; worker PID 9028 and
provider/background-dispatch flags were preserved. Environments are stored
locally with Windows DPAPI, never in this report or source control.

Deployment troubleshooting corrected the manifest UTC format, Python virtual
environment entrypoint, and isolated Core runtime module path. Adjacent
endpoint checks were repeated after these corrections.

The original one-project projection attempt returned recovery-required and
did not create a business snapshot. No direct SQL repair, AI call, mail send,
Google consent, worker restart, commit or push was performed.
