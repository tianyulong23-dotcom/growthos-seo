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

The checked-in deployment and no-secret configuration references are:

- `deploy/live/docker-compose.live001.yml`: pinned PostgreSQL 18 and Temporal
  composition used by the local-product Start path;
- `ops/local-product/local-product-auth-manifest.example.json`: Manifest shape
  with Secret References only;
- `ops/local-product/local-product-identity.example.json`: project identity
  shape with non-production sample identifiers;
- `ops/local-product/local-product-provider.env.example`: default-off Provider
  settings, bounded DataForSEO limits, and no raw credentials.

The stable Compose service/database names are deployment configuration, not
running container IDs or a local database instance UUID. Runtime roots and
Manifest paths are parameters. No checked-in file depends on a current Windows
user profile directory.

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

Validate the same startup configuration path without stopping, rebuilding, or
rewriting the running configuration:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -PreflightOnly
```

The successful output contains only capability booleans, the project key, and
the bounded DataForSEO call ceiling. It contains no Secret Reference or raw
credential. To verify fail-closed behavior in a clean location, request a real
capability against an empty runtime root:

```powershell
$clean = Join-Path $env:TEMP "growthos-local-product-clean"
.\Start-GrowthOS-LocalProduct.ps1 `
  -RuntimeRoot $clean `
  -ManifestPath (Join-Path $clean "missing-manifest.json") `
  -EnableDataForSeo `
  -PreflightOnly
```

This must fail with `LOCAL_PRODUCT_DATAFORSEO_CONFIG_REQUIRED`. Gmail produces
`LOCAL_PRODUCT_GMAIL_CONFIG_REQUIRED` under the equivalent missing-Secret
condition. It must not report Fake success or mutate the active runtime.

Start performs these checks before serving traffic:

1. rewrites only repository-external environment files for `LOCAL_PRODUCT`;
2. removes `BACKLINKS_LIVE_CANARY_STAGE` and fixed Canary recipient settings;
3. enables Gmail Send and Sync together on the first authorized start with
   `-EnableGmail`, or independently with `-EnableGmailSend` and
   `-EnableGmailSync`; later normal Start/Restart runs retain the enabled state
   while the encrypted Google OAuth client-secret reference remains available;
4. enables Browser only with `-EnableBrowser` and DataForSEO only with the
   bounded `-EnableDataForSeo` switch;
5. checks the migration manifest and builds Core and Frontend;
6. starts persistent PostgreSQL and Temporal containers;
7. verifies PostgreSQL 18, Alembic head, Backlinks migration 0054, RLS,
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

After Gmail has been enabled successfully once, a normal restart retains both
Gmail capabilities:

```powershell
.\Restart-GrowthOS-LocalProduct.ps1
```

Gmail Send and Sync remain fail-closed in CI/test mode or when explicitly
disabled. When Gmail is requested but the referenced encrypted Google OAuth
client secret is unavailable, startup fails with an explicit configuration
error instead of silently reporting a disabled or Fake-success state. Token
refresh failures are isolated to the affected organization connection and move
that connection to reauthorization-required state; they do not globally
disable healthy connections or DataForSEO.

Gmail authorization is organization-scoped. Project settings select one of the
organization's existing active connections without opening OAuth. OAuth is
used only to add a new organization connection or reauthorize an existing one.
Changing a project's selected connection applies to new sends only; existing
send intents, threads, messages, and sync cursors keep their stored project and
connection ownership.

On startup, Gmail Sync enumerates every active project mailbox binding rather
than relying on the browser's current project. The backend uses a stable
connection workflow ID, fetches provider changes once per organization
connection, and projects known-thread changes into each project's isolated
business records. A project Kill Switch, missing accepted-send lane, or one
connection failure does not stop other eligible project bindings.

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
bounded internal GrowthOS budget. It leaves the provider disabled. Start the
first authorized run with:

```powershell
.\Start-GrowthOS-LocalProduct.ps1 -EnableDataForSeo
```

The explicit start switch opens the current Website Project's project and
DataForSEO Provider Kill Switch versions. Later normal Start and Restart
commands retain the enabled state when the encrypted local Secret Reference is
still available. Tests, CI, missing-secret environments, and an explicit
`-EnableDataForSeo:$false` remain disabled. If DataForSEO is requested while
its encrypted Secret Reference is unavailable, startup returns
`LOCAL_PRODUCT_DATAFORSEO_CONFIG_REQUIRED`; it does not silently substitute a
Fake Provider. DataForSEO failure does not disable Gmail Send or Sync.

LOCAL-PRODUCT-023 authorizes one new GrowthOS internal DataForSEO cycle of
`1,000,000` USD micros and a runtime ceiling of `250` paid calls. Open or reuse
that approved cycle through the governed local operation:

```powershell
.\Open-GrowthOS-LocalProductDataForSeoBudgetCycle.ps1
```

The operation atomically closes the prior cycle when needed, opens the approved
cycle with zero spent and reserved amounts, updates API/worker/runtime restart
configuration, and preserves every older `100,000`-micros cycle and Ledger
row. It refuses active reservations or unknown-charge batches.

Reconcile an unresolved dispatched request before opening a new cycle. The
conservative resolution below records the reserved amount as GrowthOS internal
spend while preserving the failed request and no-result evidence:

```powershell
.\Resolve-GrowthOS-LocalProductDataForSeoUnknownCharge.ps1 `
  -ProviderRequestId <request-uuid> `
  -AssumeChargedAtReservation
```

This reconciliation amount is an internal accounting decision. It is not the
DataForSEO invoice, per-task billed cost, or official account balance.
DataForSEO's official account balance and the GrowthOS internal budget are
separate facts and must be reported separately.

At 70% internal cycle usage, pause optional discovery and review the Ledger.
At 100%, the existing budget gate and Provider Kill Switch enforce a hard
stop. Resume by reconciling all reservations and unknown charges, confirming
authorization, opening a new governed cycle, and leaving historical periods
unchanged. Emergency pause/resume remains controlled by the existing project
and provider Kill Switch versions; do not edit Ledger rows to simulate a
pause.

Status reports the configured ceiling, internal budget, Ledger summary, and
effective emergency shutdown state without printing the Secret Reference.
The DataForSEO official account balance is not part of this internal status
contract and must be queried and reported separately when authorized.

`blocked=false` in the status output means that the latest applicable Kill
Switch version allows the capability. It does not mean that Kill Switch
governance was removed. Historical versions remain in PostgreSQL and a later
blocked version still stops the affected project or Provider without disabling
an unrelated capability.

Recommendation, Profile, Inventory, Gmail status, and other page reads are
cache/database reads. Browser refresh, route navigation, project switching, and
expanding a panel must not dispatch DataForSEO work. Paid calls are allowed only
through the existing governed initialization, refill, explicit sync, or due
schedule paths, which retain request fingerprints, reservations, Usage Ledger
settlement, and Temporal idempotency.

The normal status view is scoped to the selected Website Project. When auditing
cost, report the selected project's current-cycle budget separately from the
global historical Usage Ledger across retained projects and closed cycles. Do
not present either value as the DataForSEO official account balance.

## Multi-project recommendation refill

The project-wide normative design is:

`docs/architecture/website-project-recommendation-blueprint-v3.md`

Commercial discovery is derived from the selected Website Project's immutable
Context plus its versioned settings:

- products, keywords, target URLs, locale, market, and language come from the
  current Project Context;
- target audiences, partnership goals, and explicit competitor domains come
  from the current Project Settings Version;
- Blueprint, discovery batches, scores, contacts, publication inventory, Jobs,
  provider requests, and Usage Ledger rows retain the Website Project and
  Context Version scope.

Do not add global discovery targets or product-domain branches. A newly created
Website Project must work through the same Context and settings contract.
Historical Contexts, Blueprints, and discovery batches remain immutable audit
facts and must be marked stale rather than overwritten or deleted.

The governed paid-discovery tier order is:

```text
exact_product_target_market
same_topic_target_market
adjacent_industry_same_audience
resource_media_review_partner_ecosystem
same_language_expansion
```

The existing `curated_resource_library` is the internal resource lane. Each
round evaluates already discovered fit supply first, then the paid tiers, then
the project-matched resource lane. If the paid provider is unavailable, the
resource lane may continue from its own persisted cursor. After both lanes are
insufficient, the next persisted round widens query coverage without relaxing
hard safety, contact, tenant, budget, idempotency, unknown-charge, or Kill
Switch gates.

The service measures publishable, contact-ready inventory rather than raw
candidate count. It proceeds to the next allowed tier while inventory remains
below the high watermark. Exhausting one bounded Blueprint/tier/window pass may
return `refillState=exhausted` and `terminationReason=TIERS_EXHAUSTED` for that
exact pass. Under the Website Project real-closure policy below, the durable
coordinator then widens the project-derived Blueprint or resumes another
eligible source while active inventory remains below 10. It must not busy-loop,
fabricate supply, or require browser refresh to advance.

The frontend manual action uses a `manual:<epoch>:<uuid>` operation-session
key, which must resolve to or resume one durable project refill debt rather than
create a parallel paid Job. A recovery from `PROVIDER_UNAVAILABLE` resumes the
saved tier/window. `BUDGET` requires governed cycle headroom and
`TIERS_EXHAUSTED` requires the next persisted Blueprint/source expansion;
neither state may be bypassed by a browser retry. Deterministic background keys
still must match the Website Project, Context Version, tier, round, and refill
debt.

DataForSEO SERP task polling is bounded by the configured request timeout, up
to `300000` milliseconds. A dispatched request whose result and charge remain
unknown must stay `unknown_charge` until explicitly reconciled; it must not be
blindly retried. Normal Restart retains the current policy, Workflow, Job,
Provider request, reservation, and Ledger facts. The single existing Worker
resumes Temporal work and does not create another queue or runtime lane.

When AI is enabled, a structured AI Blueprint is accepted only after the owned
schema validates it. An unavailable or invalid model result produces a
project-scoped `DETERMINISTIC_FALLBACK` Blueprint with an empty model version.
This gap must be reported explicitly, but it does not disable governed
DataForSEO discovery or contact processing.

Only Fit-eligible and Contact-eligible recommendations with compliant public
email evidence can enter `PUBLISHED`. Creating an Opportunity remains a
separate user-confirmed command. AI cannot create an Opportunity, send Gmail,
or change link-monitoring business state.

## Website Project real-closure policy

The reusable Website Project Blueprint contract is:

`docs/architecture/website-project-recommendation-blueprint-v3.md`

The active Website Project E2E execution manual is:

`docs/execution/WEBSITE-PROJECT-V3-E2E-001-execution-manual.md`

For a valid newly created Website Project, the first active Recommendation Pool
target is exactly 10 published, unique, project-relevant, contact-ready
recommendations. A raw candidate, a pending contact, or a Resource Library row
does not count. Fewer than 10 is not a successful local-product acceptance
state and cannot be converted to PASS by asking the user to accept a supply
floor.

While the active pool is below 10, the existing refill workflow progressively
widens project-derived Blueprint queries and evaluates both DataForSEO and the
existing Resource Library. Authority preference, exact product overlap,
category distance, score rank, query specificity, and result-window breadth
may be relaxed. Accessibility, minimum semantic relevance, safety, exclusion,
deduplication, public-contact evidence, usable recipient email, tenant scope,
idempotency, budget, unknown-charge, and Kill Switch gates may not be relaxed.

The Resource Library is internal supply infrastructure. Ordinary project users
must not browse the global catalog. They see only project-eligible entries that
have passed the same publication gates and entered their Recommendation Pool.
Admin diagnostics may inspect the global catalog. Do not create another
resource table, importer, queue, workflow, or frontend catalog.

After the first 10 are published, the visible generation remains fixed while
the user reviews it. Moving an item to Opportunity does not remove it and does
not create a one-for-one refill. The user archives the whole generation when
finished or no longer interested in that round. Archive-only leaves the
project in `awaiting_refresh` without a Job or provider request. The next
generation starts only from `Generate next generation` or
`Archive and generate next generation`, then follows the same governed
project-derived discovery path until a new fixed pool of 10 is published.
Refreshes, retries, project switches, restarts, and repeated clicks reuse the
same generation-scoped Job and provider facts.

For this closure work, the authorized GrowthOS internal DataForSEO policy is
1,000,000 micros and at most 250 paid calls per cycle. When the next request
cannot fit, the governed operation may close the exhausted cycle and open the
next authorized cycle after proving there is no unresolved unknown charge.
Historical Ledgers, reservations, requests, and settlements are retained. This
does not reset or represent the official DataForSEO account balance.

A send-ready Draft must come from the configured AI provider and pass the owned
schema, evidence, scope, and semantic checks. A deterministic template fallback
does not count as AI acceptance and cannot unlock send-ready status.

Gmail `CONNECTED` does not mean send-ready. Runtime enablement, active
authorization, project binding, scopes, Secret resolution, recipient, exact
approved Draft version, immutable send snapshot, quota, spacing, and duplicate
attempt checks must all pass. The final send remains disabled until the user
explicitly acknowledges the review and confirms the send.

An operation may display `running` only while an active Worker/Workflow can
advance it. Paused, quiesced, orphaned, terminal, input-required, and
human-waiting states must stop elapsed-time growth and expose the corresponding
recoverable reason.

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
