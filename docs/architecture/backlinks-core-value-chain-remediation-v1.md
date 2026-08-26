# Backlinks Core Value Chain Remediation V1

> Effective date: `2026-08-15`
>
> Status: `NORMATIVE`
>
> Applies to: Recommendation Pool, AI Draft, Gmail Connection/Readiness,
> Send/Sync, and LOCAL_PRODUCT provider activation
>
> Implementation status: `CONTRACT_FROZEN_PHASE_0_RUNTIME_REMEDIATION_PENDING`
>
> Target implementation baseline:
> `C:\Users\DELL\Documents\缝合\john3947-seo-main`, branch `main`, commit
> `2092d0da79cf8b126421369a9ca9db7fd4acd503`
>
> Mainline compatibility authority:
> `docs/architecture/backlinks-main-integration-compatibility-audit-v1.md`
>
> Coding entry:
> `docs/architecture/backlinks-integrated-remediation-coding-master-plan-v1.md`

## 0. Current Authority

The current authority chain is:

```text
backlinks-integrated-remediation-coding-master-plan-v1.md
-> this normative product contract
-> backlinks-main-integration-compatibility-audit-v1.md
-> backlinks-core-value-chain-remediation-implementation-plan-v1.md
-> exact phase result
```

The master plan controls scope and order, this document controls product
behavior, the compatibility audit records integrated-main constraints, and the
implementation plan controls phase ownership and verification. Historical
tasks, prototypes, and implementation notes cannot override this chain.

Phase 0 freezes this contract only. Existing V3 runtime behavior remains
active until a later phase explicitly implements and activates a new
generation contract. No corrected qualification, provider, AI, Gmail, or
Send/Sync behavior is accepted merely because it is documented here.

## 1. Product Baseline

The product is built for an ordinary operator, not for an engineer reading
logs or internal state. The primary requirements are:

1. useful results appear quickly;
2. partial progress remains usable;
3. failures identify the exact failed condition and recovery action;
4. restart and retry resume durable work instead of starting duplicate work;
5. safety rules prevent an unsafe external action, but do not hide valid
   discovery results or disable unrelated capabilities.

The system MUST NOT treat a technically safe failure as an acceptable product
outcome.

### 1.1 Project Authority And Lifecycle

The integrated platform and Backlinks domain use three separate fact
authorities:

```text
Platform Project
-> tenant identity, root project ID, domain, and lifecycle

SiteProfile / SiteProfileVersion
-> machine-discovered and refreshable website facts

ProjectOutreachProfile / PromotionTargetVersion
-> user-confirmed and immutable Backlinks intent
```

The Outreach Profile contains at least keywords/topics, products/services,
target URLs, target audiences, partnership goals, market/location/language
scope, authorized discovery sources, version, and immutable fingerprint.
SiteProfile may propose these values, but a SiteProfile refresh MUST NOT
silently change an active recommendation generation, AI draft snapshot, or
send snapshot.

Project CRUD, SiteProfile, Backlinks gateway, Gmail binding, and frontend
routes MUST resolve one authenticated organization/workspace/project
authority. An invalid, deleted, unauthorized, or archived route Project never
falls back to the first available Project.

Normal lifecycle is `ACTIVE -> ARCHIVED -> ACTIVE`. Archive preserves all
Backlinks, Gmail, Reply, Negotiation, Placement, Links, and Report evidence and
stops new paid or external actions. Restore recalculates readiness and does not
automatically start paid work. Destructive purge is a separately authorized
retention operation, not the normal Project delete action.

### 1.2 Canonical Project Entry

Production has one Project center at `/projects`. It lists, creates, archives,
restores, and enters Platform Projects. The App Shell may expose a Project
switcher, but it selects the same exact route Project through the same Project
Context and API.

The integrated `CreateProjectDialog` is the only Project-creation flow and
continues into SiteProfile/business-profile onboarding. Backlinks does not
expose a separate `网站项目` tab and does not create another Website Project.
User-confirmed products, keywords, target URLs, audiences, partnership goals,
market scope, and authorized sources are edited as a versioned
ProjectOutreachProfile from Project settings.

Legacy Project-management UI is used only as behavioral reference. Its
archive/restore, switch, detailed profile, and recoverable-error capabilities
are ported into the integrated Project center/settings instead of copying its
provider or mounting a second Project workspace.

### 1.3 Shared Project Data And Generation Inputs

The integrated product uses one Project and one shared SEO fact base. Platform
modules keep ownership of their facts:

```text
Platform Project
-> identity, domain, lifecycle

SiteProfile and owning SEO modules
-> website, product, audience, topic, key-page, keyword, competitor, SERP,
   content, and GSC evidence

ProjectOutreachProfile
-> user-confirmed Backlinks goals and matching scope

Backlinks
-> candidate qualification, accessibility, cooperation path, contact,
   recommendation, outreach, and placement evidence
```

Backlinks consumes upstream facts through a versioned Shared SEO Evidence
contract/API/projection. It MUST NOT directly read or depend on the internal
tables of colleague-owned modules.

Every recommendation generation pins:

```text
Project identity/version
SiteProfile version
ProjectOutreachProfile version
keyword/shared-evidence snapshot versions
market/location/language scope
qualification contract and request fingerprints
```

Current real-provider evidence may be reused only when Project, endpoint,
normalized parameters, market/language scope, provenance, and freshness all
match. Stale, untraceable, or mismatched evidence is rejected. Backlinks-owned
candidate Traffic, Spam, and Authority qualification uses a current live
artifact for the generation, while the same persisted artifact is reused for
the same generation/request fingerprint to prevent duplicate paid calls.

Changing Project, SiteProfile, keywords, market, or outreach intent never
mutates an in-flight generation. It creates a new input version for a new
operation. Page refresh, polling, restart, and Workflow replay only read saved
facts.

### 1.4 Prototype And Production Acceptance

The historical UI/UX document contains a static interactive prototype
contract. That contract may remain for isolated visual tests, but it is not a
production runtime contract.

1. Prototype fixtures and Mock adapters MUST remain in test, Storybook, or an
   explicit development-only entry point.
2. Production routes MUST NOT import those fixtures or fall back to fake data
   or local success when a real API call fails.
3. Prototype acceptance, screenshots, build success, generated clients, and
   HTTP `200` are not product acceptance.
4. Production success requires persisted backend facts and separately labeled
   runtime, provider, Gmail, and UAT evidence.

## 2. Recommendation Product Contract

Website matching and contact readiness are separate internal dimensions.
The six user-facing states are product projections derived from independent
facts; they are not one database field that forces discovery, matching,
contact work, drafting, sending, replies, negotiation, placement, and
monitoring into one blocking sequence.

```text
discovered
-> match_verified
-> cooperation_path_verified
-> contact_enriching
-> outreach_ready

contact_enriching
-> manual_review
```

User-facing labels are:

| Product state | Label | Meaning |
|---|---|---|
| `discovered` | 已发现 | Candidate exists; matching is still being evaluated |
| `match_verified` | 匹配已验证 | Project-specific fit passed |
| `cooperation_path_verified` | 合作路径已验证 | At least one evidence-based cooperation angle exists |
| `contact_enriching` | 联系人补充中 | Contact work is pending, running, or retryable |
| `outreach_ready` | 可发起外联 | A current eligible public contact is frozen |
| `manual_review` | 无法联系/需要人工处理 | Automation ended without a usable public contact |

Rules:

1. `discovered` is progress evidence only. It contributes to the discovered
   count and operation timeline, but does not appear as a recommendation card.
2. A recommendation becomes visible as soon as the current project-specific
   V3 fit decision is `eligible`.
3. Public email, contact confidence, purpose confidence, and a frozen contact
   evidence snapshot gate automatic `outreach_ready`; they MUST NOT gate
   Recommendation Pool visibility.
4. The current automatic-readiness thresholds remain contact confidence `80`
   and purpose confidence `70`. A lower score routes the item to
   `manual_review`; an operator may review the evidence, confirm the contact
   path, and continue. It is not silently rejected or hidden.
5. A building generation MAY show 1 through 9 verified matches immediately.
   It becomes `active` at exactly 10 visible verified matches.
6. Opportunity creation remains disabled until an eligible contact or a
   human-confirmed cooperation path exists. The UI MUST explain the blocking
   state and recovery action.
7. Contact enrichment continues asynchronously after the recommendation is
   visible. A contact failure MUST NOT remove the matched website.
8. Refill capacity is calculated from visible verified matches. Contact-ready
   count is a separate operational metric and MUST NOT cause paid discovery
   to continue after the visible target is reached.
9. Business facts and operational execution state are separate. A
   recommendation may be fit-verified while contact enrichment is retrying,
   or an Opportunity may be negotiating while Gmail sync is paused.
10. The UI may derive one `primaryNextAction` for usability. It MUST NOT persist
    that summary as a replacement for the underlying facts.
11. Recommendation list items MUST remain scan-oriented. They show only the
    decision summary and primary action; evidence history, contact versions,
    rejection detail, and secondary actions belong in a detail surface.
12. A disabled command MUST expose its exact blocker and one recovery action.
    A visually disabled control without an explanation is not an acceptable
    product state.
13. Navigation from Opportunity or Mail into Placement, Links, or Reports MUST
    preserve the available project and business-object lineage and provide a
    return path. Project switching MUST discard stale cross-project context.

The independent dimensions are at least:

```text
generation operation
recommendation qualification and visibility
cooperation path
contact
outreach content
send or manual submission
reply
negotiation
placement
link monitoring and reporting
```

### 2.1 Recommendation Qualification Contract V1

Recommendation qualification uses one ordered pipeline:

```text
resolve and pin Project, Outreach Profile, and Shared SEO Evidence inputs
-> load reusable current discovery evidence
discover candidates
-> canonicalize and deduplicate domains
-> batch-load required DataForSEO metrics
-> verify website accessibility and parseable content
-> run AI semantic assessment
-> apply non-relaxable qualification gates
-> sort eligible candidates
-> publish up to the remaining generation deficit
```

Candidate discovery first consumes matching current keyword, competitor, SERP,
content, and SiteProfile evidence exposed by the Shared SEO Evidence contract.
Missing, stale, or endpoint-specific discovery work then uses the existing
governed DataForSEO sources:

```text
POST /v3/dataforseo_labs/google/competitors_domain/live
POST /v3/backlinks/backlinks/live
POST /v3/backlinks/referring_domains/live
POST /v3/serp/google/organic/task_post
```

Competitor discovery is a two-hop supply process:

```text
elephtv.com
-> competitors_domain/live
-> bounded competitor-domain seeds only
-> backlinks/live for each selected competitor
-> page-level referring-link observations
-> canonical candidate domains
```

The first-hop competitor domains are not recommendation candidates. They only
identify sites whose backlink profiles are worth inspecting. A final
`VERIFIED_COMPETITOR_REFERRING_DOMAINS` candidate must be supported by at
least one second-hop backlink observation. `referring_domains/live` remains a
domain-level discovery source for user-site referring-domain evidence; it
must not be used to claim that a competitor seed itself is a final prospect.

Each second-hop observation retains:

```text
source page URL
competitor target page URL
anchor text
active or lost link status
first-seen timestamp
last-seen timestamp
source and target HTTP status when provided
```

The recommendation API and UI carry this evidence forward so a user can
understand why a domain was found before creating an Opportunity. Domain-only
metrics cannot substitute for page-level source and target evidence.

The current commercial discovery adapter exposes these exact source-type
labels:

```text
EXISTING_HISTORY
BLUEPRINT_SERP_STANDARD_QUEUE
VERIFIED_COMPETITOR_REFERRING_DOMAINS
VERIFIED_COMPETITOR_BACKLINK_GAP
USER_REFERRING_DOMAINS
CURATED_RESOURCE_LIBRARY
```

Every persisted candidate and product projection MUST retain one truthful
source label. A curated or user-provided source MUST NOT be relabeled as a
provider result.

At the Phase 0 baseline, the current commercial provider allowlist is:

```text
/v3/serp/google/organic/task_post
/v3/serp/google/organic/tasks_ready
/v3/serp/google/organic/task_get/advanced
/v3/dataforseo_labs/google/competitors_domain/live
/v3/backlinks/competitors/live
/v3/backlinks/backlinks/live
/v3/backlinks/referring_domains/live
```

The bulk qualification endpoints below are a frozen target contract; they are
documented but are not yet wired, allowlisted, or accepted as current runtime
behavior.

The candidate set is deduplicated before the following bulk calls. Each bulk
request is chunked to at most 1,000 canonical domains:

```text
POST /v3/dataforseo_labs/google/bulk_traffic_estimation/live
POST /v3/backlinks/bulk_spam_score/live
POST /v3/backlinks/bulk_ranks/live
```

Metric rules are:

1. Traffic uses `metrics.organic.etv`.
2. One generation persists exactly one traffic metric scope:
   `TARGET_MARKET(locationCode, languageCode)` or `GLOBAL`. Candidate metrics
   within that generation MUST NOT mix target-market and global traffic.
3. `organic.etv >= 30000` passes. A lower value is ineligible.
4. `spam_score <= 10` passes. A higher value is ineligible.
5. Bulk rank requests use `rank_scale=one_hundred`. The returned `rank` is
   stored and displayed as `DataForSEO Authority` and is used only for
   ordering. It MUST NOT qualify or reject a candidate.
6. Missing traffic or Spam Score enters the internal `awaiting_metrics` state.
   The higher-level qualification operation allows at most two bounded
   follow-up attempts for unresolved targets. A completed batch is persisted
   first, and only its unresolved target subset may enter a new linked batch
   attempt. An ambiguous synchronous `/live` dispatch becomes
   `unknown_charge` and MUST NOT be automatically resent. If either required
   metric is still absent after the allowed resolved attempts, the candidate
   becomes `metrics_unavailable`, is excluded from the current generation, and
   does not block discovery of replacement candidates.

Website accessibility rules are:

1. SafeFetch attempts the home page and one representative content page when
   a content URL is discoverable.
2. Accessibility passes only after an allowed HTTP response is successfully
   parsed into usable page text.
3. The initial attempt and at most two bounded retries are allowed.
4. Confirmed terminal failures such as an invalid domain or persistent
   not-found response make the candidate ineligible.
5. Timeouts, rate limits, access denials, and transient upstream failures
   produce internal `temporarily_unavailable`. The candidate is skipped for
   the current generation and may be re-evaluated later; it is not silently
   converted into a permanent rejection.

AI semantic assessment uses parsed page evidence and returns an auditable
0-100 result:

```text
product relevance                 50%
topic relevance                   30%
keyword and search-intent match   20%
```

Semantic decisions are:

```text
confirmed completely unrelated or score < 40
-> ineligible

score 40..59
-> fetch one additional relevant content page when available
-> run exactly one AI reassessment
-> score still < 60: ineligible

score >= 60
-> semantic gate passed
```

One retry is allowed for an unavailable, malformed, or invalid semantic
assessment. If no valid result is produced, the candidate becomes
`semantic_assessment_unavailable`, is excluded from the current generation,
and discovery continues. The legacy string-match scorer MUST NOT silently
qualify a recommendation as if a real AI semantic assessment succeeded.

The final non-relaxable qualification gates are:

```text
required Traffic present and >= 30000
required Spam Score present and <= 10
website accessibility confirmed
semantic relevance >= 60
not completely unrelated
market and language allowed when market restriction is enabled
not self, related, duplicate, suppressed, unsafe, or policy-disallowed
```

Every source, including Resource Library, passes the same metric,
accessibility, semantic, market, dedupe, and safety gates. Source type changes
where a candidate was found; it does not create a weaker quality standard.

Discovery capacity is reserved across independent source families before any
single family can consume the remaining window. The preferred order is
curated inventory, competitor second-hop backlink evidence, user referring
domains, and SERP discovery. A sparse source does not transfer authority to a
weaker qualification rule: unused source capacity may be reallocated, but the
qualification gates remain unchanged.

Eligible candidates are ordered deterministically by:

```text
semantic relevance descending
-> DataForSEO Authority descending
-> organic traffic descending
-> canonical domain ascending
```

If fewer than 10 candidates pass, discovery continues through bounded,
persisted candidate windows while executable work remains. Traffic, Spam
Score, accessibility, semantic, market, dedupe, and safety standards MUST NOT
be lowered to fill the pool. A partial pool remains visible.

The generation operation uses these separate states:

```text
idle
running
waiting_retry
paused_provider
partial_exhausted
completed
maintenance
blocked
```

`running` is allowed only while an active Worker or Workflow can advance the
operation. `partial_exhausted` means the current attempt ended below 10 after
its authorized sources/windows were exhausted. It is not successful
completion, but its verified results remain usable and elapsed processing time
stops.

Recovery actions are:

1. edit project match inputs;
2. broaden market or keywords;
3. enable or change an authorized discovery source;
4. continue the same criteria later from the saved cursor.

Changing market, keywords, or source creates a new immutable input version and
operation. It MUST NOT mutate saved evidence or silently relax hard
qualification gates. Continuing the same criteria resumes the same generation
and idempotent operation.

The product shows visible/target counts, rejection breakdown, active
processing time, next retry, provider availability, and incurred cost.
DataForSEO shows provider account balance when available and states that there
is currently no product-owned call cap. It MUST NOT invent a “remaining
budget.” `AI_DISCOVERY` and `AI_OUTREACH_DRAFT` show their separate remaining
capacity.

`awaiting_metrics`, `metrics_unavailable`, `temporarily_unavailable`,
`semantic_reassessment`, and `semantic_assessment_unavailable` are internal
candidate-processing states. They do not replace or expand the six
user-facing recommendation states.

Every verified cooperation path includes its concrete type, evidence, and an
absolute clickable HTTP(S) URL:

| Cooperation path | Required product action |
|---|---|
| `public_email` | Show the public source URL, recipient, editable draft, and Gmail action when Send Ready |
| `contact_form` | Open the form URL and provide an editable, copyable message |
| `guest_post_submission` | Open the submission URL and show the discovered requirements |
| `resource_submission` | Open the resource-submission URL and show the discovered requirements |
| `editor_author_page` | Open the editor/author URL and show the identity evidence and next action |

A path without a verifiable URL may remain diagnostic evidence, but it MUST
NOT be presented as a verified cooperation path.

The existing email Opportunity command remains an email-specific legacy
contract because it requires an eligible public contact. Corrected
non-email paths require a versioned cooperation-path-based Opportunity command;
they MUST NOT weaken the Gmail send command or fake a public-email contact.

Channel-specific editable content is:

```text
EMAIL
FORM_MESSAGE
SUBMISSION_PITCH
```

Non-email execution records at least `READY_FOR_MANUAL_ACTION`, `IN_PROGRESS`,
`SUBMITTED`, `RESPONSE_RECEIVED`, `BLOCKED`, or `ABANDONED`, plus the actor,
timestamp, path URL, evidence, and next action. Opening a URL is not proof of
submission. Automated form submission and CAPTCHA bypass are outside this
remediation unless separately authorized.

## 3. Provider Availability Contract

For a configured LOCAL_PRODUCT installation:

1. `DATAFORSEO_ENABLED=true` and `BROWSER_PROVIDER_ENABLED=true` persist across
   ordinary Start and Restart commands.
2. The normal desired state is DataForSEO provider Kill Switch
   `blocked=false` and Browser capability `enabled=true`. Ordinary startup,
   restart, health repair, and unrelated failures MUST NOT silently change
   those values. An explicit emergency or operator action may still block a
   capability and MUST be visible.
3. Test and CI runtimes remain provider-disabled.
4. DataForSEO and Browser are independent. Failure in one MUST NOT disable the
   other.
5. A missing credential, invalid secret reference, provider balance problem,
   timeout, or remote outage is reported as a named degraded state with the
   exact recovery action.
6. Accepted asynchronous provider tasks reuse the saved task identity.
   Synchronous `/live` retries are allowed only when non-dispatch is proven or
   for the unresolved subset of a successfully persisted response. An
   ambiguous dispatch becomes `unknown_charge` and MUST NOT be blindly
   repeated.
7. DataForSEO is a normal real-data source for explicit generation work.
   Upstream Project/keyword/competitor/SERP evidence may be reused only through
   the Shared SEO Evidence contract when its real-provider provenance,
   endpoint, normalized parameters, market/language scope, and freshness
   match the pinned generation.
8. There is no blind fixed cross-generation `24h` cache contract. Stale,
   untraceable, or parameter-mismatched data is never accepted. A current
   immutable shared artifact may seed discovery, and a current Backlinks live
   qualification artifact may be reused only for the same generation and
   request fingerprint. Project fit is recalculated from pinned inputs.
9. Resource Library may supplement supply, but every result MUST expose its
   truthful source. Resource Library results MUST NOT masquerade as
   DataForSEO results or hide a DataForSEO failure.
10. No product-owned DataForSEO call-count limit or internal spend ceiling is
    imposed at this stage. Provider account balance remains authoritative.
    Idempotency, duplicate-paid-request prevention, and unknown-charge
    reconciliation remain mandatory.
11. Every missing or stale discovery window and every Backlinks candidate
    qualification batch uses the approved live endpoint under an idempotent
    persisted operation. Browser refresh, route navigation, status polling,
    restart, and replay of the same operation MUST NOT create a new paid
    request.
12. Provider credential and account-health facts are shared product
    infrastructure. Recommendation, keyword, content, and other module
    operations keep separate execution state, retry policy, and budgets.

“Enabled” means the local runtime is configured and allowed to call the
provider. It cannot guarantee an external provider's uptime, credentials, or
account balance.

Every paid or externally visible provider action is classified as exactly one
of:

```text
not_dispatched
accepted_async
completed_live
retryable_no_charge
unknown_charge
```

`not_dispatched` and `retryable_no_charge` require positive evidence that no
chargeable request was accepted before an automatic retry is allowed.
`accepted_async` resumes from the saved provider task identity.
`completed_live` reuses the persisted response for the same operation and
fingerprint. `unknown_charge` blocks blind replay until reconciled.

Provider failure responses use exact machine-readable reasons, including at
least `INSUFFICIENT_PROVIDER_BALANCE`, `INVALID_PROVIDER_CREDENTIALS`,
`RATE_LIMITED`, `PROVIDER_TIMEOUT`, `PROVIDER_OUTAGE`, `UNKNOWN_CHARGE`, and
`CAPABILITY_BLOCKED`. They MUST NOT collapse to “provider unavailable”.

## 4. AI Draft Contract

Recommendation discovery AI and outreach draft AI use independent budgets,
usage ledgers, counters, and diagnostics:

```text
AI_DISCOVERY
AI_OUTREACH_DRAFT
```

Required behavior:

1. Discovery consumption cannot exhaust draft-generation capacity.
2. `AI enabled` is not shown as `Draft ready`.
3. Draft readiness reports one exact state:
   `READY`, `MISCONFIGURED`, `BUDGET_EXCEEDED`, `MALFORMED_OUTPUT`,
   `POLICY_VIOLATION`, `PROVIDER_UNAVAILABLE`, or `RETRYABLE_FAILURE`.
4. The two budget windows renew independently and immediately when their
   configured window expires. One capability cannot leave the other in a
   silently exhausted state.
5. Malformed output is retried through the saved request snapshot. If a valid
   AI draft still cannot be produced, the product creates a clearly labeled
   non-AI basic draft.
6. `MISCONFIGURED`, `BUDGET_EXCEEDED`, `MALFORMED_OUTPUT`,
   `PROVIDER_UNAVAILABLE`, and other non-policy failures MUST still leave an
   editable basic draft available to the user.
7. A `POLICY_VIOLATION` is not silently bypassed. The product explains the
   blocked content and may provide only a compliant editable basic draft.
8. Every fallback draft is editable, saveable, and distinguishable from a
   successful AI-generated draft.

## 5. Gmail Contract

The product exposes these states independently:

```text
CONNECTED
SEND_READY
SYNC_READY
```

`CONNECTED` means OAuth succeeded. `SEND_READY` additionally requires the
selected project binding, verified identity, scopes, resolvable secrets,
current approved draft/contact snapshot, quota, suppression, provider
capability, and a running execution path. `SYNC_READY` additionally requires a
valid synchronization cursor or the healthy pre-send
`waiting_for_accepted_send` state.

The UI MUST show the first blocking condition, its owner, whether retry is
safe, and one concrete recovery action.

## 6. Send And Sync Contract

1. One authoritative preflight service evaluates all send requirements and
   returns a versioned readiness snapshot.
2. Command handling and persistence enforce the snapshot version and
   idempotency key; they MUST NOT independently reimplement the entire rule
   list.
3. A state change between user confirmation and submission returns the exact
   changed condition, not an unexplained HTTP `409`.
4. A failed submission remains recoverable. The user may refresh readiness and
   retry without duplicating an accepted Gmail send.
5. Real send always requires current human confirmation.

## 7. Diagnostics And Recovery

Every primary operation exposes:

- `operationId`, `stage`, `state`, and last successful checkpoint;
- exact error code and safe user-facing explanation;
- retryability and `nextRetryAt`;
- provider/capability health without secret values;
- whether external cost may already have occurred;
- one recovery action;
- current build identity and Worker execution mode.

HTTP status alone is not sufficient diagnostic evidence.

## 8. Implementation Order

The detailed coding sequence is owned by:

`docs/architecture/backlinks-core-value-chain-remediation-implementation-plan-v1.md`

The required order is:

1. reconcile the integrated mainline Project/data contracts, exact frontend
   routing, and Shared SEO Evidence boundary without adding persistence;
2. add Project lifecycle, Outreach Profile, shared-evidence references, and
   generation pins through additive persistence and migration compatibility;
3. reconcile the integrated Core API/Worker runtime and configuration
   ownership;
4. freeze product authority and repeat the
   conflict/timeout/compatibility audit;
5. persist provider configuration and exact diagnostics;
6. add versioned storage and dual-read compatibility without switching
   behavior;
7. split AI discovery and AI draft budgets before candidate semantic calls;
8. implement bounded discovery and qualification in shadow mode;
9. activate corrected recommendation visibility for new-contract generations;
10. productize cooperation paths and contact enrichment;
11. complete the AI draft state machine;
12. consolidate Gmail readiness;
13. consolidate send/sync diagnostics while preserving final transactional
   enforcement.
14. prove reply, negotiation, Placement, link monitoring, and reporting as one
   attributed product closure path.

No business phase may start until the mainline compatibility result is
`PASS`. No phase may skip directly from documentation to frontend visibility.
Existing V3 evidence remains readable and must not be reinterpreted as
corrected qualification evidence.

## 9. Acceptance Evidence

Acceptance must label evidence separately:

1. code/contract;
2. build/typecheck;
3. migration/OpenAPI/generated client;
4. focused automated tests;
5. local runtime health;
6. real provider behavior;
7. human Gmail confirmation/send;
8. product UAT.

Passing one category MUST NOT be represented as proof of another.

Core remediation through send/sync does not by itself prove the full backlink
business lifecycle. Full product acceptance additionally requires:

1. a real reply is synchronized, matched, classified, and routed for ambiguity;
2. negotiation facts remain linked to the correct project and Opportunity;
3. an agreed result creates a Placement with source/target evidence and
   Opportunity lineage;
4. link checks produce `active`, `changed`, and `lost` facts attributed to the
   same project and report;
5. refresh, restart, multi-tab, project switching, provider timeout,
   `unknown_charge`, quiesced Worker, and duplicate-click scenarios do not
   duplicate paid work, sends, submissions, or Placements.
6. desktop, mobile, detail-drawer, confirmation-modal, disabled-action,
   network-reconnect, and cross-module deep-link scenarios retain readable
   layout, exact project context, and server-confirmed outcomes.
