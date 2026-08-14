# Website Project Recommendation Blueprint V3

> Effective date: `2026-08-13`
>
> Status: `NORMATIVE`
>
> Applies to: every current and future Website Project
>
> Fixed generation target: `10`

## 1. Purpose

This document is the project-wide authority for recommendation discovery,
publication, fixed-pool review, archive, next-generation behavior, and the
downstream handoff from Opportunity through AI Draft and Gmail Send Ready.

`LOCAL-PRODUCT-038` was a historical acceptance attempt.
`WEBSITE-PROJECT-V3-E2E-001` is retained as historical evidence.
`WEBSITE-PROJECT-V3-E2E-002` is the current full-workflow revalidation task.
Manito Silk, SmileTV, AWOL, ElephTV, and any other named project are test
inputs only. No runtime branch, fixture, cache, resource binding, or threshold
may depend on a project name or a known domain.

The required product outcome is:

```text
valid Website Project
-> immutable project Context and Settings
-> project-derived Blueprint V3
-> governed DataForSEO and Resource Library discovery
-> progressive soft-threshold expansion
-> contact verification and publication
-> exactly 10 visible recommendations
-> fixed user review generation
-> whole-generation archive
-> explicit next-generation command
-> repeat with project-history deduplication
-> selected recommendation becomes Opportunity
-> real evidence-grounded AI Draft
-> project-bound Gmail Send Ready
-> human final confirmation
-> sent-message and reply synchronization
```

The words MUST, MUST NOT, SHOULD, and MAY are normative.

## 2. Product Invariants

1. Every recommendation MUST be derived from the selected Website Project's
   persisted Context and Settings Version.
2. A complete new project MAY initialize generation 1 exactly once through an
   idempotent command. Generation 2 and later MUST require an explicit user
   command.
3. The visible target for every generation is exactly 10 unique,
   project-relevant, contact-ready, published recommendations.
4. A generation MUST remain `building` until the target is reached. A partial
   generation MUST NOT be presented as a successful pool.
5. An `active` generation is a fixed user workset. Moving a recommendation to
   Opportunity MUST NOT remove it and MUST NOT trigger one-for-one refill.
6. Archive-only MUST create no refill Job, Workflow dispatch, provider request,
   reservation, or Usage Ledger charge.
7. Browser reads, refreshes, route navigation, project switching, and opening
   a Resource Library view MUST NOT create provider work.
8. Resource Library inventory is internal supply infrastructure. Ordinary
   project users MUST see only entries that passed the selected project's
   publication gates.
9. Old-generation workers and delayed provider results MUST NOT write into a
   newer generation.
10. Real Gmail send always stops at the human final-confirmation boundary.
11. Gmail `CONNECTED`, Gmail Send Ready, and Gmail Sync Ready are different
    states and MUST be projected separately.
12. A pre-send project with no accepted Gmail send MUST show
    `waiting_for_accepted_send`; it MUST NOT appear broken, indefinitely
    loading, or falsely synchronized.
13. A maintenance or quiesced Worker MUST be visible in recommendation,
    draft, send, and mail-center state. It MUST NOT be presented as active
    business processing.

## 3. Blueprint Input Contract

Blueprint V3 MUST be built from the immutable selected-project inputs:

```text
projectContextVersionId
projectSettingsVersionId
projectSettingsVersion
canonicalDomain
countries
languages
products
keywords
promotionTargetUrls
declaredTargetAudiences
partnershipGoals
explicitCompetitorDomains
historicalFeedbackDomains
evidenceRefs
```

The normalized inputs MUST produce a stable fingerprint. A changed Context or
Settings Version creates a new immutable Blueprint fact; it MUST NOT overwrite
the historical Blueprint used by an earlier generation.

Blueprint V3 output includes:

```text
targetAudience
productValuePropositions
topicClusters
searchQueryClusters
targetSiteArchetypes
cooperationAngles
negativeKeywords
excludedSiteTypes
competitorSuggestions
discoveredCompetitorSeeds
sourceHierarchy
generator
generationMode
fallbackReason
promptVersion
modelVersion
ruleVersion
evidenceRefs
```

The source hierarchy is:

```text
PROJECT_EXPLICIT_COMPETITORS
DATAFORSEO_CURRENT_DOMAIN_COMPETITORS
PROJECT_MARKET_SERP
INDUSTRY_EDITORIAL_ECOSYSTEM
```

An AI Blueprint is accepted only after the owned strict schema validates it.
If the AI provider is unavailable or returns invalid output, the system MAY
use `DETERMINISTIC_FALLBACK` to construct discovery hypotheses from the same
project inputs. The fallback MUST be identified honestly and MUST NOT be
reported as successful AI generation.

## 4. Publishable Definition

The generation target is:

```text
visiblePoolTargetCount=10
publishable=fitEligible AND contactEligible AND publicEmailPresent
```

The following do not count:

- raw search candidates;
- candidates waiting for static assessment;
- candidates waiting for contact enrichment;
- rejected, suppressed, unsafe, or duplicate domains;
- global Resource Library rows that have not passed project-specific gates;
- template drafts or unrelated Opportunities.

Publication MUST lock the generation policy, count only the current generation,
cap publication at its remaining deficit, and transition to `active` only when
the current generation reaches exactly 10.

## 5. Adaptive Supply Algorithm

### 5.1 Source Order

For each round, the coordinator uses this order:

1. already discovered fit-eligible candidates awaiting contact/publication;
2. DataForSEO paid discovery across the five progressive tiers;
3. project-matched Resource Library candidates;
4. the next persisted round and query window if both lanes remain insufficient.

If the paid provider is paused or unavailable, the Resource Library lane SHOULD
continue where eligible. Provider recovery resumes the saved paid cursor; it
does not restart from the first paid request.

### 5.2 Paid Discovery Tiers

Paid discovery MUST progress in this order:

| Tier | Intent |
|---|---|
| `exact_product_target_market` | Exact product, target market, target audience, editorial/review intent |
| `same_topic_target_market` | Same topic and market with broader keywords and content formats |
| `adjacent_industry_same_audience` | Adjacent categories serving the same audience and cooperation intent |
| `resource_media_review_partner_ecosystem` | Media, guides, reviews, associations, communities, directories, and partner ecosystems |
| `same_language_expansion` | Same-language expansion after target-market supply is insufficient |

`curated_resource_library` is the governed internal resource tier. It is not a
customer-facing catalog and is evaluated through the same fit, contact, dedupe,
and publication path.

### 5.3 Query Expansion

Each tier builds bounded combinations from the project's:

- products and keywords;
- topic clusters and value propositions;
- audiences and partnership goals;
- target-site archetypes;
- cooperation angles;
- market and language;
- progressively broader editorial and resource intents.

Each `(generation, tier, round, window)` identifies one durable search window.
The query window advances through persisted cursors. Repeated commands reuse or
resume the same window instead of creating a parallel paid Job.

Two consecutive completed windows with zero eligible candidates allow the
coordinator to advance to the next tier. After paid and resource lanes are
exhausted, the next round starts from persisted state with broader query
coverage. The coordinator MUST NOT busy-loop.

### 5.4 Adaptive Sample Size

Requested candidate volume SHOULD be calculated from the remaining deficit and
observed conversion rates:

```text
raw -> fit
fit -> contact-ready
contact-ready -> published
```

The request remains bounded by the configured candidate limit. Low historical
conversion increases the requested raw sample; it does not lower hard safety or
contact requirements.

### 5.5 Soft Thresholds

The following MAY be progressively relaxed and MUST record the effective tier,
round, rule version, and reason:

- authority preference;
- exact product-term overlap;
- exact category distance;
- ranking score;
- query specificity;
- result-window breadth;
- target-market strictness only through the explicit same-language tier.

### 5.6 Hard Gates

The following MUST NOT be relaxed:

- public HTTP accessibility and canonical-domain validity;
- minimum semantic relevance to the selected project;
- self-domain and related-domain exclusion;
- duplicate, prior-decision, prior-generation, and existing-link rules;
- permanent rejection and suppression rules;
- unsafe, prohibited, spam, and policy-risk exclusions;
- public contact evidence and a usable recipient email;
- Organization, Workspace, Website Project, Context, and generation isolation;
- idempotency and duplicate-provider-request controls;
- provider budget, reservation, Usage Ledger, and unknown-charge controls;
- Kill Switch and runtime authorization;
- human approval for Opportunity creation and Gmail send.

## 6. Durable Coordinator

The coordinator MUST persist enough information to resume after browser
refresh, process restart, Worker restart, provider pause, or budget rotation:

```text
organization/workspace/project
projectContextVersionId/projectSettingsVersionId
blueprintVersion/ruleVersion/inputFingerprint
visiblePoolGeneration/visiblePoolState
paidTier/paidRound/paidWindow/paidCursor
resourceRound/resourceWindow/resourceCursor
attemptedTiers and conversion evidence
candidate decisions and rejection reasons
contact decisions and evidence
provider request/reservation/ledger identities
termination or pause reason
job/workflow/outbox/idempotency identities
```

The idempotency and refill identity MUST include at least:

```text
websiteProjectId
projectContextVersionId
visiblePoolGeneration
tier
round
window
```

A stale command for an older generation MUST fail with conflict or replay its
already completed historical result. It MUST NOT mutate the current generation.

## 7. Generation State Machine

The normative state machine is:

```text
idle
  -> building
  -> active
  -> awaiting_refresh
  -> building
```

### `idle`

No generation work has started. A complete new project MAY start generation 1
once through the governed idempotent initialization command.

### `building`

Discovery, reassessment, contact enrichment, and publication may advance the
current generation. The user sees progress, not a successful partial pool.

### `active`

Exactly 10 items were published for the current generation. This list remains
fixed while the user searches, reviews, skips, or moves items to Opportunity.

### `awaiting_refresh`

The prior generation was archived and the next generation number was reserved.
No discovery starts until the user explicitly requests the next generation.

## 8. Archive And Refresh Commands

### Archive Current Generation

The command MUST:

1. lock the current `active` generation;
2. archive its visible inventory;
3. increment `visiblePoolGeneration`;
4. set `visiblePoolState=awaiting_refresh`;
5. append lifecycle and audit evidence;
6. create no refill Job or provider side effect;
7. replay safely for the same idempotency key.

### Generate Next Generation

The command MUST:

1. accept only the current positive generation;
2. transition `idle` or `awaiting_refresh` to `building`;
3. create or resume exactly one generation-scoped refill debt;
4. reuse the same Job and provider facts on repeated clicks;
5. refill to exactly 10 before transitioning to `active`.

### Archive And Generate Next Generation

This UI action is two explicit durable operations:

```text
archive current generation
-> if archive succeeds, request next generation
```

If archive succeeds but generation startup fails, the project remains safely
in `awaiting_refresh`. The user may retry `Generate next generation` without
re-archiving or duplicating provider work.

## 9. Resource Library Boundary

The existing Resource Library is a hidden supply lane.

Ordinary users MUST NOT:

- browse the full global catalog;
- see unrelated project resources;
- be required to select a resource before discovery can proceed;
- treat a `paid` resource label as authorization to purchase.

Ordinary users MAY see a published recommendation's truthful source, match
reason, and free/paid attribute after it passes project-specific gates.
Admin-only diagnostics MAY inspect the global catalog.

No second resource table, importer, queue, Workflow, or frontend catalog is
permitted.

## 10. Pause And Failure Semantics

These outcomes are recoverable pauses, not successful completion:

| Reason | Required behavior |
|---|---|
| `PROJECT_CONTEXT_REQUIRED` | Wait for valid project inputs; make no paid call |
| `PAUSED_PROVIDER` | Persist cursor and resume after provider recovery |
| `PAUSED_BUDGET` | Reconcile unknown charges and rotate only an authorized internal cycle |
| contact processing | Wait for the existing contact pipeline |
| `SUPPLY_FLOOR_REACHED` / `TIERS_EXHAUSTED` | Keep acceptance not passed; report exact evidence |

`SUPPLY_FLOOR_REACHED` MUST NOT activate a partial generation or ask the user to
accept fewer than 10. New work may resume only from a legitimate changed input,
new eligible source, broader governed Blueprint/rule version, reconciled
provider state, or explicit authorized cycle continuation.

An operation may display `running` only while an active Worker or Workflow can
advance it. Quiesced, orphaned, terminal, human-waiting, input-required, and
paused states MUST stop elapsed-time growth and show the real reason.

## 11. UI Contract

The Recommendation Pool MUST show:

- current generation number;
- current state;
- fixed target of 10;
- current-generation published count;
- archived historical count;
- honest progress or pause reason;
- `Archive current generation`;
- `Generate next generation` only in `awaiting_refresh`;
- `Archive and generate next generation` when the current generation is active.

Moving an item to Opportunity MUST leave it visible in the current generation
with its updated state. The UI MUST NOT imply that a replacement is being
generated.

## 12. Mail Center And Gmail Readiness Contract

The Mail Center is part of the Website Project closure path. It MUST use the
selected project's tenant-scoped Gmail binding and MUST NOT infer readiness
from connection state alone.

The product MUST distinguish these states:

```text
not_connected
connected_not_send_ready
send_ready_waiting_for_human_confirmation
waiting_for_accepted_send
syncing
sync_ready
maintenance_paused
configuration_error
provider_error
```

`connected_not_send_ready` means OAuth is valid but at least one required send
gate is absent, including the active project binding, configured send
capability, normal Worker mode, approved immutable Draft Version, recipient,
quota, suppression, or final preflight.

`waiting_for_accepted_send` is a healthy pre-send sync state. A Gmail History
cursor is not required before the first accepted send. The status endpoint
MUST return this state promptly and the UI MUST explain why no project thread
exists yet.

After an accepted send, the system MUST establish or resume the connection
cursor, persist the sent message, run incremental sync idempotently, and show
the latest success or a visible failure. Restart MUST reuse the same connection
and cursor. It MUST NOT create duplicate messages, duplicate workflows, or
cross-project mail visibility.

The status implementation MUST NOT issue concurrent queries through one
transaction-scoped PostgreSQL client. Status reads MUST complete within the
Gateway timeout, and local acceptance SHOULD complete them within two seconds.

The ordinary project UI MUST show:

- connection identity and connection state;
- send-readiness state and the exact missing gate;
- sync state, latest success, and latest visible error;
- `waiting_for_accepted_send` when no accepted send exists;
- maintenance/quiesced state instead of a false running indicator;
- persisted messages belonging to the selected project only.

The UI MUST NOT hide the only sync diagnostic in test-only markup. It MUST NOT
start a real send or paid/provider operation from page mount, refresh,
navigation, or project switching.

## 13. Acceptance Matrix

The implementation is accepted only when tests prove:

1. arbitrary project inputs create a project-derived Blueprint with no named
   project branch;
2. generation 1 initialization is idempotent;
3. publication remains `building` at 0 through 9 and becomes `active` at 10;
4. an 11th item cannot enter the same fixed visible generation;
5. Opportunity creation does not remove an item or request refill;
6. archive-only archives the whole generation and creates zero Jobs, provider
   requests, reservations, and outbox dispatches;
7. explicit next-generation request creates exactly one generation-scoped Job;
8. repeated click, refresh, and restart reuse that Job;
9. stale old-generation work cannot publish into the new generation;
10. prior-generation domains are excluded from the next generation;
11. Resource Library supply is project-filtered and hidden from ordinary users;
12. provider, budget, unknown-charge, Kill Switch, and tenant gates fail closed;
13. desktop and mobile UI expose the same fixed-pool lifecycle;
14. a real evidence-grounded AI Draft is persisted without template fallback
    being counted as AI success;
15. Gmail connection, Send Ready, and Sync Ready are projected independently;
16. pre-send Mail Center returns `waiting_for_accepted_send` without timeout;
17. post-send cursor establishment and restart recovery are idempotent;
18. mail visibility remains project-scoped;
19. maintenance/quiesced runtime is visibly paused across the full workflow;
20. no real Gmail send occurs without current human confirmation.

Build, OpenAPI, generated-client, and HTTP 200 checks are necessary but do not
prove real provider supply, real AI generation, Gmail send readiness, or human
UAT. Those claims require separately labeled runtime evidence.

## 14. Implementation Pointers

Primary implementation surfaces:

```text
backend/core/src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.ts
backend/core/src/modules/backlinks/domain/recommendations/commercial-refill-cycle.ts
backend/core/src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts
backend/core/src/modules/backlinks/application/services/commercial-supply-operation.service.ts
backend/core/src/modules/backlinks/application/services/recommendation-publication.service.ts
backend/core/src/modules/backlinks/application/commands/recommendations.command.ts
backend/core/src/modules/backlinks/application/queries/recommendations.query.ts
backend/core/src/modules/backlinks/db/migrations/0059_backlink_recommendation_pool_generations.sql
backend/core/src/modules/backlinks/api/recommendation-commands.route.ts
backend/core/src/modules/backlinks/runtime/local-product-gmail-runtime.ts
backend/core/src/modules/backlinks/runtime/local-product-gmail-sync-runtime.ts
backend/core/src/modules/backlinks/application/workflows/gmail-polling-sync-workflow.ts
backend/core/src/modules/backlinks/api/gmail-connection.route.ts
backend/api/app/api/routes/backlinks.py
frontend/src/features/outreach/recommendations/recommendations-workspace.tsx
frontend/src/features/outreach/mail/mail-center.tsx
frontend/src/features/outreach/mail/mail-sync-status-panel.tsx
```

The reusable Blueprint schema is `commercial-discovery-blueprint.v3`; the
fixed-pool generation persistence is introduced by migration `0059`.

## 15. Prohibited Regressions

The following changes violate this architecture:

- project-name or domain-specific behavior;
- accepting fewer than 10 as a successful generation;
- one-for-one refill after use, skip, reject, or Opportunity creation;
- starting generation 2 from a GET, refresh, project switch, or page mount;
- exposing the entire Resource Library to ordinary project users;
- allowing old-generation results into the current generation;
- losing cursors and restarting paid discovery after restart;
- bypassing provider governance to reach 10;
- presenting deterministic fallback as real AI success;
- treating Gmail `CONNECTED` as send-ready;
- treating a missing pre-send History cursor as a synchronization failure;
- hiding sync timeout, maintenance, or provider failure from the project user;
- running concurrent queries through one transaction-scoped PostgreSQL client;
- leaking messages or Gmail bindings across projects or tenants;
- automatic Gmail send without final human confirmation.
