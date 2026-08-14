# LOCAL-PRODUCT-038 Website Project Real Closure Contract

> Historical contract. `WEBSITE-PROJECT-V3-E2E-001` supersedes this task.
> The current fixed generation target is 10. Do not execute the 20-item
> acceptance rules below as current product instructions.

- Effective date: `2026-08-13`
- Scope: `LOCAL-PRODUCT-038`
- Product boundary: arbitrary newly created Website Projects
- Repository: `C:\Users\DELL\Documents\缝合\john3947-seo`
- Execution skill:
  `C:\Users\DELL\.codex\skills\growthos-scope-gated-execution\SKILL.md`
- Detailed coding manual:
  `C:\Users\DELL\Documents\缝合\GrowthOS-任意Website-Project真实闭环最终Coding指令手册-V3.0-2026-08-12.md`
- Project-wide Blueprint authority:
  `docs/architecture/website-project-recommendation-blueprint-v3.md`

## 1. Authority

This was the normative product contract for the reopened
`LOCAL-PRODUCT-038` closure work. It is no longer active.

It instantiates the reusable Website Project architecture defined by
`docs/architecture/website-project-recommendation-blueprint-v3.md`. Where this
file describes the 038 acceptance project, the architecture document remains
the authority for all current and future Website Projects.

It supersedes any earlier statement that permits one of the following outcomes
to count as Website Project product acceptance:

- fewer than 20 contact-ready recommendations;
- a user-accepted supply-floor explanation;
- a global Resource Library catalog shown as an ordinary project feature;
- a deterministic template presented as a successful AI draft;
- `CONNECTED` Gmail status without send-readiness checks;
- an inactive Worker operation displayed as indefinitely `running`.
- one-for-one recommendation refill after an item is used, rejected, or moved
  to Opportunity.

Historical result documents remain evidence of what was observed at that time.
They are not current acceptance authority where they conflict with this file.

The words MUST, MUST NOT, SHOULD, and MAY are normative.

## 2. Product Outcome

Given a valid public commercial website, the product MUST:

1. create a Website Project from normal product inputs without manual SQL;
2. derive all discovery behavior from that project's persisted Context and
   Settings Version;
3. publish a first active pool of exactly 20 unique, project-relevant,
   contact-ready recommendations;
4. keep each visible generation stable until the user archives the whole pool,
   then create the next generation only after an explicit user command;
5. use DataForSEO, Blueprint expansion, existing Resource Library supply, and
   the existing contact pipeline as one governed supply path;
6. create a real AI-generated draft for a user-selected Opportunity;
7. expose a selected Gmail connection as send-ready only after every runtime,
   authorization, scope, secret, quota, recipient, and approved-version check
   passes;
8. stop at the human final-send boundary without sending automatically.

`LOCAL-PRODUCT-038` is not accepted with fewer than 20 recommendations. If
external reality makes 20 impossible after all governed sources are exhausted,
the run MUST remain not passed and report exact evidence. It MUST NOT fabricate
supply and MUST NOT convert the shortage into a product PASS.

## 3. Project Isolation

Runtime behavior MUST NOT contain branches, defaults, cached global facts, or
special resources keyed to ElephTV, AWOL, SmileTV, Manito Silk, or any other
named acceptance project.

Every durable record involved in the flow MUST retain the correct:

- Organization;
- Workspace;
- Website Project;
- Project Context Version;
- Settings Version where applicable;
- Blueprint, refill cycle, batch, Job, and provider-request identity.

Switching projects MUST immediately read the selected project's persisted
facts. A route read, browser refresh, or tab change MUST NOT create a new
generation or dispatch another paid provider call. A complete new project's
first generation MAY be scheduled once through an idempotent initialization
command. Generation 2 and later MUST require an explicit user command.

## 4. Recommendation Inventory Contract

The active recommendation target is:

```text
activeHighWatermark=20
firstPoolRequired=20
publishableDefinition=fitEligible AND contactEligible AND publicEmailPresent
```

Raw candidates, domains awaiting contact processing, rejected candidates, and
Resource Library rows do not count toward 20.

While a generation is `building`, the existing durable refill path MUST keep
expanding the exact project/context until exactly 20 publishable items exist.
The generation becomes `active` only at 20. It MUST NOT expose a partially
built generation as a successful recommendation pool.

An `active` generation is a fixed user workset. Moving an item to Opportunity
MUST NOT remove it from that generation and MUST NOT create a one-for-one
refill debt. An explicit per-item rejection or invalidation MAY reduce the
displayed workset, but it MUST NOT start another generation or paid request.

Each refill cycle MUST retain its tier, round, query window, cursor, source,
dedupe facts, rejection reasons, provider request, reservation, and settlement.
The next cycle MUST resume from durable state rather than starting discovery
again from the first paid request.

The Recommendation Pool MUST expose these commands:

- `Archive current generation`: archive its remaining visible inventory, move
  policy state to `awaiting_refresh`, and create no Job or provider request;
- `Archive and generate next generation`: archive the current generation and
  explicitly start the next generation;
- `Generate next generation`: resume from `awaiting_refresh` if archive
  succeeded but generation startup did not.

Each generation MUST have a persisted positive generation number. Jobs,
refills, discovery batches, candidates, inventory, idempotency keys, and
frontend operation leases MUST carry that generation. Late work from an older
generation MUST NOT publish into a newer generation.

The next generation MUST exclude the project's self-domain, duplicate domains,
prior decisions, Opportunities, and domains already discovered or published
in earlier generations. It MUST repeat the governed expansion path until the
new fixed pool reaches exactly 20.

## 5. Supply Expansion

The supply engine MUST progressively widen Blueprint discovery until 20
publishable recommendations exist.

Recommended order:

1. exact product, target market, target audience, and stronger authority;
2. exact product and target audience with lower authority;
3. same topic and same target audience;
4. adjacent product category with the same audience and outreach intent;
5. editorial, review, media, guide, association, community, and partner
   ecosystems generated from the current project;
6. project-matched entries from the existing Resource Library;
7. regenerated Blueprint queries with broader synonyms, intents, result
   windows, and adjacent ecosystems;
8. repeat the governed DataForSEO and Resource Library evaluation from the
   saved next cursor until 20 publishable items exist.

These are soft dimensions and MAY be relaxed:

- authority preference;
- exact product-term overlap;
- exact category distance;
- score rank;
- search query specificity;
- result window breadth.

These hard gates MUST NOT be relaxed:

- public HTTP accessibility and valid canonical domain;
- minimum semantic relevance to the current project;
- excluded-domain, self-domain, duplicate, and prior-decision rules;
- low-risk and policy-compliant site classification;
- public contact evidence;
- a usable public recipient email;
- project, tenant, and context isolation;
- provider budget, idempotency, unknown-charge, and Kill Switch controls.

Lowering a soft threshold MUST be recorded with the effective tier, rule
version, and reason. It MUST NOT silently change historical candidate facts.

## 6. Resource Library

The Resource Library is internal supply infrastructure, not an ordinary
customer-facing catalog.

The ordinary project UI MUST NOT expose all 455 global resources or require the
user to browse them. It may show only recommendations that:

1. match the selected project's Blueprint and authority policy;
2. pass the same fit, safety, dedupe, contact, and publication gates as paid
   discovery;
3. have already entered the selected project's Recommendation Pool.

Internal/admin diagnostics MAY inspect the global catalog. A recommendation
may truthfully identify `curated_resource_library` as its source and its
free/paid resource attribute, but that metadata does not authorize purchase or
bypass human decisions.

No second resource table, importer, workflow, queue, or frontend catalog is
allowed. Migration `0057_backlink_resource_library.sql` and the existing
resource identities remain immutable.

## 7. DataForSEO Budget Continuity

The user authorizes successive GrowthOS internal DataForSEO cycles for this
closure work:

```text
cycleLimitMicros=1000000
maxPaidCallsPerCycle=250
```

When remaining internal cycle headroom cannot authorize the next valid paid
request, the governed operation SHOULD atomically:

1. verify there is no unresolved `unknown_charge`;
2. close the exhausted internal cycle;
3. open the next authorized 1,000,000-micros cycle;
4. retain all historical Ledger, reservation, request, and settlement rows;
5. resume the same Website Project refill cycle from its saved cursor.

This is an internal GrowthOS budget rotation. It MUST NOT be described as the
official DataForSEO account balance and MUST NOT erase or reset provider
history.

No automatic rotation is allowed while an unknown charge is unresolved, the
Provider Kill Switch is closed, credentials cannot be resolved, or the
official provider account rejects the request.

## 8. AI Draft Contract

A send-ready acceptance draft MUST be produced by the configured AI provider
and pass:

- owned structured-output schema validation;
- evidence and recipient grounding;
- project and Opportunity scope validation;
- semantic checks for subject/body coherence;
- persisted model run, prompt version, request fingerprint, and draft version.

A deterministic template fallback MAY remain as a diagnostic recovery aid, but
it MUST NOT count as AI acceptance, MUST NOT be labelled AI-generated, and MUST
NOT unlock send-ready status.

Provider, schema, or semantic failure MUST be explicit and resumable. Refresh
or retry MUST reuse the same Job and request fingerprint when the prior
provider outcome is already known.

## 9. Gmail Send-Ready Contract

`CONNECTED` alone is insufficient.

The final-send control becomes available only when all of the following are
true:

- Gmail Send runtime capability is enabled;
- the Organization connection is active and authorized;
- the current Website Project is bound to that connection;
- required OAuth scopes and external secret references resolve;
- recipient, approved draft version, and immutable send snapshot match;
- quota and minimum-interval checks pass;
- no prior accepted, in-flight, or acceptance-unknown attempt conflicts;
- the user checks the final review acknowledgement.

The product MUST wait for the user's explicit final confirmation. It MUST NOT
send automatically during project creation, recommendation refill, Opportunity
creation, draft generation, page refresh, startup, or acceptance testing.

## 10. Truthful State And Recovery

An operation may display `running` only while an active Worker/Workflow can
actually advance it or a bounded provider poll is in progress.

Quiesced, orphaned, timed-out, exhausted, failed, input-required, and
human-waiting work MUST use distinct persisted and projected states.

Displayed elapsed time MUST stop at the terminal, pause, or waiting timestamp.
Restart MUST resume the same Job/Workflow and MUST NOT duplicate paid requests,
recommendations, Opportunities, drafts, or send intents.

## 11. Test Isolation And Cleanup

Automated acceptance MUST use an isolated tenant/workspace/project namespace or
disposable database. Tests MUST NOT depend on AWOL, ElephTV, SmileTV, Manito
Silk, or the current canonical database contents.

Cleanup MUST be scoped by generated test identities. Shared tables, migrations,
provider Ledgers, resource identities, OAuth bindings, and user-created
projects MUST NOT be truncated or globally deleted.

Before real acceptance:

1. create a PostgreSQL backup;
2. identify and quarantine failed automated-test records;
3. retain historical provider and audit facts;
4. create Manito Silk through the same public product path used by a user.

## 12. Acceptance

The real acceptance target is:

```text
website=https://manitosilk.com/
market=United States
product=pajamas
```

The gate requires evidence that:

1. the project was created without SQL or project-specific code;
2. the first active pool contains 20 unique contact-ready recommendations;
3. source counts and every relaxation tier are auditable;
4. moving one recommendation to Opportunity does not create a refill or remove
   it from the active generation;
5. the ordinary project UI does not expose the global Resource Library;
6. archiving the current generation creates no refill Job and leaves the
   project in `awaiting_refresh`;
7. an explicit next-generation command creates exactly one generation-scoped
   Job and eventually publishes a new pool of 20 domains not used before;
8. one selected recommendation becomes one Opportunity;
9. a real schema-valid AI draft is generated;
10. Gmail is connected, synchronized, and send-ready;
11. the product waits for the user's final send confirmation;
12. restart, refresh, repeated clicks, and project switching do not duplicate
    work or show a
    false indefinite-running state.

Final status may be `PASS_WITH_EXTERNAL_ACTION` only when all code and real
provider checks above pass and the only remaining action is the user's final
send confirmation. The result MUST state that no send, reply, or acquired-link
outcome has yet been proven.
