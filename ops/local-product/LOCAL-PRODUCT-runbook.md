# GrowthOS Backlinks Local Product Runbook

This runbook operates the Backlinks product entirely on one Windows machine.
It does not publish a public endpoint and does not configure DNS, tunnels,
Google Search Console, Indexing API, or Sitemap API.

## Runtime

The managed product stack is:

- Frontend: `http://localhost:5173`
- FastAPI Gateway: `http://localhost:7200`
- private Backlinks Core: `http://127.0.0.1:7301`
- PostgreSQL 18: `127.0.0.1:55432`
- Temporal: `127.0.0.1:57233`
- Temporal metrics: `127.0.0.1:59090`
- Backlinks Worker: private process connected to PostgreSQL and Temporal

The browser must use FastAPI. Port 7301 is loopback-only and is not a browser
API.

The default external runtime root is
`%LOCALAPPDATA%\GrowthOS\live001`. The directory name is retained to reuse the
verified persistent PostgreSQL volume, Temporal volume, Gmail Token references,
and protected Secret Store from local acceptance. It does not select a LIVE
stage. New processes run with `BACKLINKS_RUNTIME_MODE=LOCAL_PRODUCT`.
The external identity must reference a real local product project. Start rejects
Canary project keys/names and `.example.invalid` domains.

Initialize the retained independent local Project without replacing its UUID
or Gmail connection:

```powershell
.\Initialize-GrowthOS-LocalProductProject.ps1 `
  -ProjectKey "elephtv" `
  -ProjectName "ElephTV" `
  -ProjectDomain "elephtv.com"
```

The initializer only accepts the historical LIVE-001 local Project identity or
the exact requested product identity. It adds a new Backlinks Project Context
snapshot and leaves historical snapshots unchanged.

Create a provider-free Recommendation entry point for a real prospect hostname:

```powershell
.\Initialize-GrowthOS-LocalProductRecommendation.ps1 `
  -ProspectHostname "prospect.example.org"
```

This initializer uses the restricted Backlinks application role with RLS
enabled. It does not create an Opportunity, Contact, Draft, SendIntent, email,
reply, or provider result. Replace the sample hostname with the real prospect
chosen for the local product workflow; Canary hostnames and `.example.invalid`
are rejected.

## Daily Product Workflow

The normal local product workflow is:

1. Select an authorized Website Project, or create one and provide its real
   domain, market, language, products, keywords, and target URLs.
2. Review continuously replenished Recommendations and their public contact
   evidence.
3. Confirm a suitable Recommendation to create an Opportunity. The newest
   Opportunity appears first in the current work list.
4. Generate an AI-assisted Draft from the selected Opportunity and confirmed
   Contact. The page follows the same backend Job until it completes; it does
   not create a second AI call merely because the page was refreshed.
5. Review and approve the Draft, then explicitly confirm Gmail sending.
6. Use Gmail sync to observe replies and confirm their Opportunity match.
7. Register or import a real Placement, verify it directly, and keep its
   monitoring policy active.

Removing an Opportunity from the current work list archives it. It does not
delete Contacts, Drafts, Send facts, replies, Placements, monitoring evidence,
events, or audit history. Archived Opportunities are available through an
explicit filter and may be restored.

The project selector changes the complete Website Project context. Project
queries, Gmail connections, Provider switches and budgets, Recommendations,
Opportunities, Drafts, mail, Placements, and monitoring facts must remain
project-scoped. A configured default project may choose the initial route, but
must not hide other authorized active projects.

If a project's products, keywords, or target URLs are incomplete, finish that
project's setup before starting Recommendation replenishment. Do not copy
another project's profile or use demo defaults.

## Start

From the repository root:

```powershell
.\Start-GrowthOS-LocalProduct.ps1
```

Start performs these checks before serving traffic:

1. rewrites only repository-external environment files for `LOCAL_PRODUCT`;
2. removes `BACKLINKS_LIVE_CANARY_STAGE` and fixed Canary recipient settings;
3. enables Gmail Send and Sync together only with `-EnableGmail`, or
   independently with `-EnableGmailSend` and `-EnableGmailSync`;
4. enables Browser only with `-EnableBrowser` and DataForSEO only with the
   bounded `-EnableDataForSeo` switch;
5. checks the migration manifest and builds Core and Frontend;
6. starts persistent PostgreSQL and Temporal containers;
7. verifies PostgreSQL 18, Alembic head, Backlinks migration 0040, RLS,
   DataForSEO Worker policies, and the immutable Send Snapshot trigger;
8. starts Core, Worker, FastAPI, and Frontend in independent process groups;
9. waits for each readiness signal.

AI remains disabled when its repository-external credential reference and
budget configuration are absent. Install them through the hidden-input
bootstrap; do not put the API key in a command argument, environment variable,
Manifest, or repository file:

```powershell
.\Import-GrowthOS-LocalProductAiCredential.ps1
```

The bootstrap accepts the model ID, model version label, exact token rates,
and a budget no greater than USD 1.00. It stores the API key at
`secret://growthos/local-product/ai/provider-credential/v1`, writes only safe
configuration to the repository-external Manifest and runtime environment,
and leaves the AI Provider and database Kill Switch disabled. After those
values are installed, start with:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -EnableAi
```

The explicit start switch opens the current Website Project's AI database
Kill Switch version.

Start the current local product with the configured real Gmail connection,
shared Browser Worker, and AI Provider while leaving DataForSEO off:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 `
  -EnableAi `
  -EnableGmail `
  -EnableBrowser
```

Provider call ceilings and Gmail limits remain configurable:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 `
  -EnableAi `
  -EnableGmail `
  -EnableBrowser `
  -AiMaxCalls 25 `
  -GmailRolling24HourSendLimit 20 `
  -GmailMinimumIntervalSeconds 120 `
  -GmailPollingIntervalSeconds 60
```

Install the DataForSEO credential and bounded local-product inputs through the
hidden-input bootstrap:

```powershell
.\Import-GrowthOS-LocalProductDataForSeoCredential.ps1
```

The bootstrap accepts a legal DataForSEO Secret Reference, one or more
official v3 endpoints, project inputs, a configurable call ceiling, and a
bounded budget. It leaves the provider disabled. Start with:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -EnableDataForSeo
```

The explicit start switch opens the current Website Project's project and
DataForSEO Provider Kill Switch versions. Status reports the configured
ceiling, budget, Ledger summary, and effective emergency shutdown state
without printing the Secret Reference.

## Status

```powershell
.\Status-GrowthOS-LocalProduct.ps1
.\Status-GrowthOS-LocalProduct.ps1 -Json
```

Status reports URLs, process groups, listeners, HTTP readiness, PostgreSQL and
Temporal health, migration heads, Provider switches and ceilings, current
budget usage and remaining amount, non-sensitive persisted fact counts, and
safe error categories from the current run. It never prints database
credentials, OAuth credentials, access tokens, refresh tokens, Secret
References, email addresses, subjects, or message content.

## Restart

Restart application processes while preserving the last Provider switches and
limits:

```powershell
.\Restart-GrowthOS-LocalProduct.ps1 -SkipBuild
```

Override one or more retained values explicitly:

```powershell
.\Restart-GrowthOS-LocalProduct.ps1 `
  -EnableDataForSeo:$false `
  -EnableGmail `
  -SkipBuild
```

Restart PostgreSQL and Temporal as well, without deleting their named volumes:

```powershell
.\Restart-GrowthOS-LocalProduct.ps1 `
  -RestartInfrastructure `
  -SkipBuild
```

## Stop

```powershell
.\Stop-GrowthOS-LocalProduct.ps1
```

Stop sends a graceful console break to Frontend, FastAPI, Worker, and Core,
then stops PostgreSQL and Temporal. Named volumes and the external Secret Store
are retained.

## Recovery

If Start reports a port conflict, inspect the owning process. The script never
kills an unmanaged listener. If a managed start fails, inspect the matching
files under `%LOCALAPPDATA%\GrowthOS\live001\logs`.

Do not delete Docker named volumes or the external Secret Store as a recovery
step. Use the verified backup/restore procedure or a forward migration.
