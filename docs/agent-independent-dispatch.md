# Independent Agent dispatch

`AGENT_BACKGROUND_DISPATCH_ENABLED=true` enables the existing Agent dispatch loop
even when `PLATFORM_BACKGROUND_DISPATCH_ENABLED=false`. The default is false.
The existing global-on behavior is unchanged and starts only one Agent loop.

With only Agent enabled, queued Agent runs (including consent-bound backlink
continuations and serial send batches) are dispatched and reconciled. New
onboarding/system triggers are not materialized. Other platform background
loops, including content, audits, keywords and project projection, stay off.
Explicit Agent commands still use their existing authorization and tool rules.

Set the Agent flag in the Platform API environment or `backend/api/.env`.
For `scripts/dev-up.ps1`, set it in the supplied `-EnvironmentFile` (by default
`deploy/compose/.env`). It is a persistent startup setting, not a per-email gate.
Restart the idle Platform API after changing it. The existing Agent Worker and
Core sending worker must be running; Gmail readiness, quotas and send authority
are unchanged. Do not change the global runtime mode just to enable Agent.

The API cancels and awaits its owned dispatch task on shutdown. Dispatch retains
the existing database idempotency and Temporal workflow IDs. Revoked/cancelled
requests are not reauthorized by enabling the loop. Queue acceptance is not
provider acceptance, delivery, or a reply.
